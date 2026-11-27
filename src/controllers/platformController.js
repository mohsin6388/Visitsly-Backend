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
  // Approximate, in INR list prices (priceOverride is INR).
  const price = require('../config/pricing').planPrice(getPlan(org.plan).code, 'INR');
  const monthly = org.priceOverride || (org.billingCycle === 'annual' ? (price.annual || 0) / 12 : price.monthly || 0);
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
  if (b.featureOverrides !== undefined) {
    // null value = remove the override (back to the plan default).
    const next = {};
    for (const [k, v] of Object.entries(b.featureOverrides || {})) if (typeof v === 'boolean') next[k] = v;
    org.featureOverrides = next;
    org.markModified('featureOverrides');
  }
  // Only the platform admin may change the billing country / currency after onboarding.
  if (b.country && b.country !== org.country) {
    org.country = b.country;
    org.currency = require('../config/pricing').currencyForCountry(b.country);
  }
  if (b.priceOverride !== undefined) org.priceOverride = b.priceOverride || null;
  if (b.notes !== undefined) org.notes = b.notes;
  if (b.addons) {
    if (b.addons.extraUsers > 0 && !require('../services/saas/permissions').teamAvailable(org)) {
      throw ApiError.badRequest('Extra users can only be granted on Growth and above (Starter and Trial have no team)');
    }
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

/** GET /api/platform/orgs/:id/email — sender state + wallet WITH our cost / margin split (admin only). */
const emailOverview = asyncHandler(async (req, res) => {
  const org = await Organization.findById(req.params.id).select('name emailWallet').lean();
  if (!org) throw ApiError.notFound('Company not found');
  const wallet = require('../services/email/emailWallet');
  const EmailSender = require('../models/EmailSender');
  const EmailWalletTx = require('../models/EmailWalletTx');
  const sender = await EmailSender.findOne({ orgId: org._id }).lean();
  const p = wallet.pricing();
  const rows = await EmailWalletTx.find({ orgId: org._id, type: 'debit', refundedAt: null }).select('costMilli marginMilli').lean();
  const sum = rows.reduce((a, t) => ({ cost: a.cost + (t.costMilli || 0), margin: a.margin + (t.marginMilli || 0) }), { cost: 0, margin: 0 });
  return new ApiResponse(200, {
    sender: sender ? { email: sender.email, status: sender.status, domain: sender.domain, domainAuthStatus: sender.domainAuthStatus, paused: sender.paused, pausedReason: sender.pausedReason } : null,
    wallet: {
      ...wallet.summary(org),
      costPerEmail: p.costMilli / 1000,
      marginPerEmail: p.marginMilli / 1000,
      totalCost: sum.cost / 1000,
      totalMargin: sum.margin / 1000,
      history: (await EmailWalletTx.find({ orgId: org._id, type: { $ne: 'debit' } }).sort({ createdAt: -1 }).limit(30).lean()).map((t) => ({ type: t.type, emails: t.emails, amount: t.amountMilli / 1000, note: t.note, at: t.createdAt })),
    },
  }).send(res);
});

/** POST /api/platform/orgs/:id/email-credit { emails, note } — manual credit (negative = correction). Audited. */
const emailCredit = asyncHandler(async (req, res) => {
  const emails = Math.trunc(Number(req.body?.emails));
  if (!Number.isFinite(emails) || !emails || Math.abs(emails) > 1000000) throw ApiError.badRequest('Enter a non-zero number of emails (max 1,000,000)');
  const org = await Organization.findById(req.params.id).select('_id').lean();
  if (!org) throw ApiError.notFound('Company not found');
  const r = await require('../services/email/emailWallet').adminAdjust(org._id, { emails, actorId: req.user.actorId, note: req.body?.note });
  if (!r.changed) throw ApiError.badRequest(r.reason === 'insufficient' ? 'Wallet balance is lower than this correction' : 'Nothing changed');
  await AuditLog.create({ userId: req.user.actorId, orgId: org._id, action: 'platform.email.credit', entityType: 'Organization', entityId: org._id, meta: { emails, note: req.body?.note || '' }, ip: req.ip });
  return new ApiResponse(200, { wallet: require('../services/email/emailWallet').summary(await Organization.findById(org._id).select('emailWallet').lean()) }, 'Email wallet updated').send(res);
});

/** POST /api/platform/orgs/:id/email-unpause — after review, let a paused company send again. Audited. */
const emailUnpause = asyncHandler(async (req, res) => {
  const org = await Organization.findById(req.params.id).select('_id').lean();
  if (!org) throw ApiError.notFound('Company not found');
  await require('../models/EmailSender').updateOne({ orgId: org._id }, { $set: { paused: false, pausedReason: null, pausedAt: null } });
  await AuditLog.create({ userId: req.user.actorId, orgId: org._id, action: 'platform.email.unpause', entityType: 'Organization', entityId: org._id, ip: req.ip });
  return new ApiResponse(200, { ok: true }, 'Email sending resumed').send(res);
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
/** GET /api/platform/payments/:id/pdf — any company's invoice (platform admin). Same PDF service as the customer. */
const paymentPdf = asyncHandler(async (req, res) => {
  if (!/^[a-f\d]{24}$/i.test(String(req.params.id))) throw ApiError.notFound('Invoice not found');
  const { buffer, filename } = await require('../services/billing/invoiceService').pdfFor({ _id: req.params.id });
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Length': buffer.length,
    'Cache-Control': 'private, no-store',
  });
  return res.status(200).send(buffer);
});

const listPayments = asyncHandler(async (req, res) => {
  const filter = {};
  if (['paid', 'failed', 'refunded'].includes(req.query.status)) filter.status = req.query.status;
  const items = await Invoice.find(filter).sort({ createdAt: -1 }).limit(500).populate('orgId', 'name city').lean();
  const total = items.filter((i) => i.status === 'paid').reduce((a, i) => a + (i.amount || 0), 0);
  return new ApiResponse(200, {
    // Invoice document fields (invoiceNumber, subtotal, taxAmount, emailedAt, billedTo) are returned as stored.
    items: items.map((i) => ({
      ...i,
      invoiceNumber: i.invoiceNumber || null,
      subtotal: i.subtotal ?? null,
      taxAmount: i.taxAmount ?? null,
      emailedAt: i.emailedAt || null,
      billedTo: i.billedTo || null,
      org: i.orgId ? { id: String(i.orgId._id), name: i.orgId.name, city: i.orgId.city } : null,
      orgId: undefined,
    })),
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
  if (await User.exists({ email })) throw ApiError.conflict('A login already exists for this email');
  const user = new User({ name: req.body.name, email, role: 'admin', isSuperAdmin: true, orgId: null });
  user.setPassword(req.body.password);
  await user.save();
  await AuditLog.create({ userId: req.admin.id, action: 'platform.admin.create', entityType: 'User', entityId: user._id, meta: { email }, ip: req.ip });
  return new ApiResponse(201, { admin: adminView(user) }, 'Admin added').send(res);
});

const updateAdmin = asyncHandler(async (req, res) => {
  if (req.params.id === req.admin.id && req.body.isActive === false) throw ApiError.badRequest('You can’t deactivate yourself');
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

/* ------------------------------------------------------------------ */
/* Coupons + plan offers (admin panel)                                 */
/* ------------------------------------------------------------------ */
const Coupon = require('../models/Coupon');
const CouponRedemption = require('../models/CouponRedemption');
const PlanOffer = require('../models/PlanOffer');
const pricingConfig = require('../config/pricing');
const pricingService = require('../services/billing/pricingService');

const OBJECT_ID = /^[a-f\d]{24}$/i;
const dupMessage = (err, what) => (/E11000|duplicate/i.test(err.message) ? ApiError.conflict(`${what} already exists`) : err);

/** GET /api/platform/coupons */
const listCoupons = asyncHandler(async (req, res) => {
  const items = await Coupon.find({}).sort({ createdAt: -1 }).limit(500).lean();
  return new ApiResponse(200, { items }).send(res);
});

/** POST /api/platform/coupons */
const createCoupon = asyncHandler(async (req, res) => {
  const b = { ...req.body, code: pricingService.normaliseCode(req.body.code) };
  if (b.type === 'percent') b.currency = null;
  let coupon;
  try {
    coupon = await Coupon.create({ ...b, createdBy: req.user.actorId });
  } catch (err) {
    throw dupMessage(err, 'A coupon with this code');
  }
  await AuditLog.create({ userId: req.user.actorId, action: 'platform.coupon.create', entityType: 'Coupon', entityId: coupon._id, meta: { code: coupon.code, type: coupon.type, value: coupon.value }, ip: req.ip });
  return new ApiResponse(201, { coupon }, 'Coupon created').send(res);
});

/** PATCH /api/platform/coupons/:id — edit, or { active:false } to disable. */
const updateCoupon = asyncHandler(async (req, res) => {
  const existing = await Coupon.findById(req.params.id).lean();
  if (!existing) throw ApiError.notFound('Coupon not found');
  const merged = { ...existing, ...req.body };
  if (merged.type === 'flat' && !merged.currency) throw ApiError.badRequest('A flat coupon needs a currency');
  if (merged.type === 'percent' && merged.value > 100) throw ApiError.badRequest('A percent coupon can be at most 100');
  const update = { ...req.body };
  if (update.type === 'percent') update.currency = null;
  const coupon = await Coupon.findByIdAndUpdate(req.params.id, { $set: update }, { new: true }).lean();
  await AuditLog.create({ userId: req.user.actorId, action: req.body.active === false ? 'platform.coupon.disable' : 'platform.coupon.update', entityType: 'Coupon', entityId: coupon._id, meta: { code: coupon.code, changes: req.body }, ip: req.ip });
  return new ApiResponse(200, { coupon }, 'Coupon updated').send(res);
});

/** POST /api/platform/coupons/:id/disable */
const disableCoupon = asyncHandler(async (req, res) => {
  if (!OBJECT_ID.test(String(req.params.id))) throw ApiError.notFound('Coupon not found');
  const coupon = await Coupon.findByIdAndUpdate(req.params.id, { $set: { active: false } }, { new: true }).lean();
  if (!coupon) throw ApiError.notFound('Coupon not found');
  await AuditLog.create({ userId: req.user.actorId, action: 'platform.coupon.disable', entityType: 'Coupon', entityId: coupon._id, meta: { code: coupon.code }, ip: req.ip });
  return new ApiResponse(200, { coupon }, 'Coupon disabled').send(res);
});

/** GET /api/platform/coupons/:id/redemptions */
const couponRedemptions = asyncHandler(async (req, res) => {
  if (!OBJECT_ID.test(String(req.params.id))) throw ApiError.notFound('Coupon not found');
  const items = await CouponRedemption.find({ couponId: req.params.id }).sort({ createdAt: -1 }).limit(200).lean();
  return new ApiResponse(200, { items }).send(res);
});

/** GET /api/platform/plan-offers */
const listPlanOffers = asyncHandler(async (req, res) => {
  const items = await PlanOffer.find({}).sort({ plan: 1, cycle: 1, currency: 1 }).lean();
  return new ApiResponse(200, { items }).send(res);
});

/** PUT /api/platform/plan-offers — create or replace the offer for plan + cycle + currency. */
const setPlanOffer = asyncHandler(async (req, res) => {
  const { plan, cycle, currency, offerPrice, label = '', validFrom = null, validUntil = null, active = true } = req.body;
  if (!pricingConfig.supported(currency)) throw ApiError.badRequest(`${currency} is not a supported currency`);
  const p = pricingConfig.planPrice(plan, currency);
  const listPrice = cycle === 'annual' ? p.annual : p.monthly;
  const price = pricingService.roundFor(offerPrice, currency);
  if (!listPrice || !(price < listPrice)) throw ApiError.badRequest(`The offer price must be lower than the list price (${currency} ${listPrice}).`);
  if (validFrom && validUntil && validFrom > validUntil) throw ApiError.badRequest('validUntil must be after validFrom');
  const offer = await PlanOffer.findOneAndUpdate(
    { plan, cycle, currency },
    { $set: { offerPrice: price, label, validFrom, validUntil, active, createdBy: req.user.actorId } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
  await AuditLog.create({ userId: req.user.actorId, action: 'platform.offer.set', entityType: 'PlanOffer', entityId: offer._id, meta: { plan, cycle, currency, offerPrice: price, listPrice, active }, ip: req.ip });
  return new ApiResponse(200, { offer }, 'Offer saved').send(res);
});

/** DELETE /api/platform/plan-offers/:id — clears the offer (list price applies again). */
const clearPlanOffer = asyncHandler(async (req, res) => {
  if (!OBJECT_ID.test(String(req.params.id))) throw ApiError.notFound('Offer not found');
  const offer = await PlanOffer.findByIdAndDelete(req.params.id).lean();
  if (!offer) throw ApiError.notFound('Offer not found');
  await AuditLog.create({ userId: req.user.actorId, action: 'platform.offer.clear', entityType: 'PlanOffer', entityId: offer._id, meta: { plan: offer.plan, cycle: offer.cycle, currency: offer.currency }, ip: req.ip });
  return new ApiResponse(200, { cleared: true }, 'Offer cleared').send(res);
});

module.exports = {
  emailOverview, emailCredit, emailUnpause, listCoupons, createCoupon, updateCoupon, disableCoupon, couponRedemptions, listPlanOffers, setPlanOffer, clearPlanOffer, stats, listOrgs, getOrgDetail, updateOrg, recordPayment, supportSession, listPayments, paymentPdf, listAdmins, createAdmin, updateAdmin, listRequests, updateRequest, activity, revenue };
