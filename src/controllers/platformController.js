const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const Organization = require('../models/Organization');
const User = require('../models/User');
const Lead = require('../models/Lead');
const Invoice = require('../models/Invoice');
const AuditLog = require('../models/AuditLog');
const orgService = require('../services/saas/orgService');
const billing = require('../services/saas/billingService');
const { orgSummary } = require('../services/saas/orgSummary');
const { getPlan, PLANS } = require('../config/plans');
const { subscriptionState } = require('../services/saas/subscription');
const PlatformRequest = require('../models/PlatformRequest');
const env = require('../config/env');
const { signSupportToken } = require('../utils/tokens');

const DAY = 24 * 60 * 60 * 1000;

/** Monthly recurring revenue contribution of one org (INR, before GST). */
function mrrOf(org) {
  if (org.status !== 'active' && org.status !== 'past_due') return 0;
  const plan = getPlan(org.plan);
  const monthly = org.priceOverride || (org.billingCycle === 'annual' ? plan.annual / 12 : plan.monthly);
  return Math.round(monthly);
}

/** GET /api/platform/stats */
const stats = asyncHandler(async (req, res) => {
  const orgs = await Organization.find({}).select('plan status billingCycle priceOverride trialEndsAt createdAt usage').lean();
  const now = Date.now();
  const byStatus = {};
  const byPlan = {};
  let mrr = 0;
  let trialsEndingSoon = 0;
  for (const o of orgs) {
    byStatus[o.status] = (byStatus[o.status] || 0) + 1;
    byPlan[o.plan] = (byPlan[o.plan] || 0) + 1;
    mrr += mrrOf(o);
    if (o.status === 'trialing' && o.trialEndsAt && new Date(o.trialEndsAt) - now < 3 * DAY && new Date(o.trialEndsAt) > now) trialsEndingSoon += 1;
  }
  const since = new Date(now - 30 * DAY);
  const [signups30d, paid30d] = await Promise.all([
    Organization.countDocuments({ createdAt: { $gte: since } }),
    Invoice.aggregate([{ $match: { status: 'paid', paidAt: { $gte: since } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
  ]);
  return new ApiResponse(200, {
    totalOrgs: orgs.length,
    byStatus,
    byPlan,
    mrr,
    arr: mrr * 12,
    signups30d,
    collected30d: paid30d[0]?.total || 0,
    trialsEndingSoon,
  }).send(res);
});

/** GET /api/platform/orgs?status=&plan=&search= */
const listOrgs = asyncHandler(async (req, res) => {
  const { status, plan, search } = req.query;
  const filter = {};
  if (status) filter.status = status;
  if (plan) filter.plan = plan;
  if (search) {
    const rx = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ name: rx }, { city: rx }, { billingEmail: rx }, { phone: rx }, { 'whatsapp.displayPhoneNumber': rx }];
  }
  const orgs = await Organization.find(filter).sort({ createdAt: -1 }).limit(500).lean();
  const ownerIds = orgs.map((o) => o.ownerUserId);
  const [owners, leadCounts, userCounts] = await Promise.all([
    User.find({ _id: { $in: ownerIds } }).select('name email phone lastLoginAt').lean(),
    Lead.aggregate([{ $match: { ownerId: { $in: ownerIds } } }, { $group: { _id: '$ownerId', n: { $sum: 1 } } }]),
    User.aggregate([{ $match: { orgId: { $in: orgs.map((o) => o._id) }, isActive: true } }, { $group: { _id: '$orgId', n: { $sum: 1 } } }]),
  ]);
  const ownerMap = new Map(owners.map((u) => [String(u._id), u]));
  const leadMap = new Map(leadCounts.map((r) => [String(r._id), r.n]));
  const userMap = new Map(userCounts.map((r) => [String(r._id), r.n]));
  const items = orgs.map((o) => {
    const owner = ownerMap.get(String(o.ownerUserId));
    const usage = orgService.usageFor(o);
    return {
      id: String(o._id),
      name: o.name,
      city: o.city,
      businessType: o.businessType,
      plan: o.plan,
      planName: getPlan(o.plan).name,
      billingCycle: o.billingCycle,
      status: o.status,
      subscription: subscriptionState(o),
      trialEndsAt: o.trialEndsAt,
      currentPeriodEnd: o.currentPeriodEnd,
      mrr: mrrOf(o),
      owner: owner ? { name: owner.name, email: owner.email, phone: owner.phone, lastLoginAt: owner.lastLoginAt } : null,
      contacts: leadMap.get(String(o.ownerUserId)) || 0,
      users: userMap.get(String(o._id)) || 0,
      aiConversations: usage.aiConversations,
      messagesSent: usage.messagesSent,
      whatsapp: { status: o.whatsapp?.connectedVia === 'env' ? 'connected' : o.whatsapp?.status, number: o.whatsapp?.displayPhoneNumber || null },
      createdAt: o.createdAt,
    };
  });
  return new ApiResponse(200, { items }).send(res);
});

/** GET /api/platform/orgs/:id */
const getOrgDetail = asyncHandler(async (req, res) => {
  const snap = await orgService.getSnapshot(req.params.id, { fresh: true });
  if (!snap) throw ApiError.notFound('Company not found');
  const [team, invoices, org] = await Promise.all([
    User.find({ orgId: snap._id }).select('name email phone orgRole isActive lastLoginAt createdAt').lean(),
    Invoice.find({ orgId: snap._id }).sort({ createdAt: -1 }).limit(50).lean(),
    Organization.findById(snap._id).select('notes limitOverrides priceOverride suspendedReason addons branding').lean(),
  ]);
  return new ApiResponse(200, {
    org: { ...(await orgSummary(snap)), notes: org.notes, limitOverrides: org.limitOverrides || {}, suspendedReason: org.suspendedReason, addons: org.addons || {}, branding: org.branding || {} },
    team,
    invoices,
  }).send(res);
});

/** PATCH /api/platform/orgs/:id — plan, status, trial, limits, notes, custom price. */
const updateOrg = asyncHandler(async (req, res) => {
  const org = await Organization.findById(req.params.id);
  if (!org) throw ApiError.notFound('Company not found');
  const b = req.body;
  if (b.plan) {
    if (!PLANS[b.plan]) throw ApiError.badRequest('Unknown plan');
    org.plan = b.plan;
  }
  if (b.billingCycle) org.billingCycle = b.billingCycle;
  if (b.status) {
    org.status = b.status;
    org.suspendedReason = b.status === 'suspended' ? b.suspendedReason || 'Suspended by PropAI' : null;
    if (b.status === 'active' && (!org.currentPeriodEnd || org.currentPeriodEnd < new Date())) {
      org.currentPeriodEnd = new Date(Date.now() + (org.billingCycle === 'annual' ? 365 : 30) * DAY);
    }
  }
  if (b.extendTrialDays) {
    const from = org.trialEndsAt && org.trialEndsAt > new Date() ? org.trialEndsAt : new Date();
    org.trialEndsAt = new Date(from.getTime() + Number(b.extendTrialDays) * DAY);
    if (org.status !== 'active') org.status = 'trialing';
  }
  if (b.currentPeriodEnd) org.currentPeriodEnd = new Date(b.currentPeriodEnd);
  if (b.limitOverrides !== undefined) org.limitOverrides = b.limitOverrides || {};
  if (b.priceOverride !== undefined) org.priceOverride = b.priceOverride || null;
  if (b.notes !== undefined) org.notes = b.notes;
  if (b.addons) {
    for (const k of ['extraUsers', 'extraNumbers', 'aiPacks']) if (b.addons[k] !== undefined) org.addons[k] = b.addons[k];
  }
  if (b.branding) {
    for (const k of ['productName', 'logoUrl', 'primaryColor', 'customDomain']) if (b.branding[k] !== undefined) org.branding[k] = b.branding[k];
  }
  org.markModified('limitOverrides');
  await org.save();
  orgService.invalidate(org._id);
  if (b.branding) await require('../services/saas/corsOrigins').refreshCustomDomains();
  await AuditLog.create({ userId: req.user.actorId, orgId: org._id, action: 'platform.org.update', entityType: 'Organization', entityId: org._id, meta: b, ip: req.ip });
  return new ApiResponse(200, { org: await orgSummary(await orgService.getSnapshot(org._id, { fresh: true })) }, 'Company updated').send(res);
});

/** POST /api/platform/orgs/:id/payments — record offline (UPI/bank) payment. */
const recordPayment = asyncHandler(async (req, res) => {
  await billing.recordOfflinePayment(req.params.id, req.body);
  await AuditLog.create({ userId: req.user.actorId, orgId: req.params.id, action: 'platform.org.payment', entityType: 'Organization', meta: req.body, ip: req.ip });
  return new ApiResponse(200, { org: await orgSummary(await orgService.getSnapshot(req.params.id, { fresh: true })) }, 'Payment recorded').send(res);
});

/** POST /api/platform/orgs/:id/support-session — open the company in the customer app (60 min). */
const supportSession = asyncHandler(async (req, res) => {
  const org = await Organization.findById(req.params.id).select('name').lean();
  if (!org) throw ApiError.notFound('Company not found');
  const admin = await User.findById(req.admin.id);
  const token = signSupportToken(admin, org._id);
  await AuditLog.create({ userId: admin._id, orgId: org._id, action: 'platform.support_session', entityType: 'Organization', entityId: org._id, ip: req.ip });
  // Token goes in the URL fragment so it never reaches server logs.
  const url = `${env.clientUrl.replace(/\/+$/, '')}/support#token=${encodeURIComponent(token)}&org=${encodeURIComponent(org.name)}`;
  return new ApiResponse(200, { url, expiresInMinutes: 60 }).send(res);
});

/** GET /api/platform/payments?status= — every invoice across companies. */
const listPayments = asyncHandler(async (req, res) => {
  const filter = {};
  if (['paid', 'failed', 'refunded'].includes(req.query.status)) filter.status = req.query.status;
  const items = await Invoice.find(filter).sort({ createdAt: -1 }).limit(500).populate('orgId', 'name city').lean();
  const total = items.filter((i) => i.status === 'paid').reduce((a, i) => a + (i.amount || 0), 0);
  return new ApiResponse(200, {
    items: items.map((i) => ({ ...i, org: i.orgId ? { id: String(i.orgId._id), name: i.orgId.name, city: i.orgId.city } : null, orgId: undefined })),
    totalPaid: total,
  }).send(res);
});

/* ---- PropAI admin users ---- */
const adminView = (u) => ({ id: String(u._id), name: u.name, email: u.email, isActive: u.isActive, lastLoginAt: u.lastLoginAt, createdAt: u.createdAt });

const listAdmins = asyncHandler(async (req, res) => {
  const or = [{ isSuperAdmin: true }];
  if (env.saas.superAdminEmails.length) or.push({ email: { $in: env.saas.superAdminEmails } });
  const admins = await User.find({ $or: or }).sort({ createdAt: 1 }).lean();
  return new ApiResponse(200, { items: admins.map(adminView) }).send(res);
});

const createAdmin = asyncHandler(async (req, res) => {
  const email = String(req.body.email).trim().toLowerCase();
  if (await User.exists({ email })) throw ApiError.conflict('Is email se pehle se login hai');
  const user = new User({ name: req.body.name, email, role: 'admin', isSuperAdmin: true, orgId: null });
  user.setPassword(req.body.password);
  await user.save();
  await AuditLog.create({ userId: req.admin.id, action: 'platform.admin.create', entityType: 'User', entityId: user._id, meta: { email }, ip: req.ip });
  return new ApiResponse(201, { admin: adminView(user) }, 'Admin added').send(res);
});

const updateAdmin = asyncHandler(async (req, res) => {
  if (req.params.id === req.admin.id && req.body.isActive === false) throw ApiError.badRequest('Aap khud ko deactivate nahi kar sakte');
  const user = await User.findOne({ _id: req.params.id, isSuperAdmin: true });
  if (!user) throw ApiError.notFound('Admin not found');
  if (typeof req.body.isActive === 'boolean') {
    user.isActive = req.body.isActive;
    if (!user.isActive) user.adminRefreshTokenHash = null;
  }
  if (req.body.name) user.name = req.body.name;
  await user.save();
  await AuditLog.create({ userId: req.admin.id, action: 'platform.admin.update', entityType: 'User', entityId: user._id, meta: req.body, ip: req.ip });
  return new ApiResponse(200, { admin: adminView(user) }).send(res);
});

/* ---- Customer requests (add-ons, Enterprise, white-label, voice) ---- */
const listRequests = asyncHandler(async (req, res) => {
  const filter = {};
  if (['open', 'done', 'rejected'].includes(req.query.status)) filter.status = req.query.status;
  const items = await PlatformRequest.find(filter).sort({ createdAt: -1 }).limit(300).populate('orgId', 'name city plan').populate('userId', 'name email phone').lean();
  return new ApiResponse(200, { items }).send(res);
});

const updateRequest = asyncHandler(async (req, res) => {
  const r = await PlatformRequest.findById(req.params.id);
  if (!r) throw ApiError.notFound('Request not found');
  if (req.body.status) {
    r.status = req.body.status;
    r.resolvedAt = req.body.status === 'open' ? null : new Date();
  }
  if (req.body.adminNote !== undefined) r.adminNote = req.body.adminNote;
  await r.save();
  return new ApiResponse(200, { request: r }).send(res);
});

/** GET /api/platform/activity — recent platform + signup + payment events. */
const activity = asyncHandler(async (req, res) => {
  const items = await AuditLog.find({ action: { $regex: '^(platform\\.|auth\\.signup|billing\\.|admin\\.)' } })
    .sort({ createdAt: -1 })
    .limit(100)
    .populate('userId', 'name email')
    .populate('orgId', 'name')
    .lean();
  return new ApiResponse(200, { items }).send(res);
});

/** Revenue by month (last 12 months) for the admin dashboard chart. */
const revenue = asyncHandler(async (req, res) => {
  const since = new Date();
  since.setMonth(since.getMonth() - 11, 1);
  since.setHours(0, 0, 0, 0);
  // Grouped in JS (IST months) — simple and portable across MongoDB versions.
  const monthKey = (d) => new Date(new Date(d).getTime() + 330 * 60000).toISOString().slice(0, 7);
  const [paid, orgs] = await Promise.all([
    Invoice.find({ status: 'paid', paidAt: { $gte: since } }).select('amount paidAt').lean(),
    Organization.find({ createdAt: { $gte: since } }).select('createdAt').lean(),
  ]);
  const rows = new Map();
  paid.forEach((i) => rows.set(monthKey(i.paidAt), (rows.get(monthKey(i.paidAt)) || 0) + (i.amount || 0)));
  const signups = new Map();
  orgs.forEach((o) => signups.set(monthKey(o.createdAt), (signups.get(monthKey(o.createdAt)) || 0) + 1));
  const months = [];
  for (let i = 0; i < 12; i += 1) {
    const d = new Date(since);
    d.setMonth(since.getMonth() + i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    months.push({ month: key, revenue: rows.get(key) || 0, signups: signups.get(key) || 0 });
  }
  return new ApiResponse(200, { months }).send(res);
});

module.exports = { stats, listOrgs, getOrgDetail, updateOrg, recordPayment, supportSession, listPayments, listAdmins, createAdmin, updateAdmin, listRequests, updateRequest, activity, revenue };
