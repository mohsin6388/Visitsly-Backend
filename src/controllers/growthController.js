const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const env = require('../config/env');
const Organization = require('../models/Organization');
const User = require('../models/User');
const Lead = require('../models/Lead');
const PlatformRequest = require('../models/PlatformRequest');
const AuditLog = require('../models/AuditLog');
const orgService = require('../services/saas/orgService');
const { ensureCaptureKey, newKey } = require('../services/leads/leadCapture');
const metaLeadAds = require('../services/leads/metaLeadAds');
const { assignLead, eligibleUsers } = require('../services/leads/routing');

/**
 * Company-level growth settings: lead sources (website form, hosted form,
 * portals by email, Google Ads, Meta Lead Ads), lead routing, weekly report,
 * and requests to PropAI (add-ons, Enterprise, white-label, voice).
 */
function apiBase(req) {
  return (process.env.PUBLIC_API_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '').replace(/\/api$/, '');
}

async function sourcesView(req, orgId) {
  const key = await ensureCaptureKey(orgId);
  const org = await Organization.findById(orgId).lean();
  const base = apiBase(req);
  const inboundUrl = `${base}/api/inbound/leads/${key}`;
  const inboundDomain = env.brevo.inboundDomain;
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const bySource = await Lead.aggregate([
    { $match: { ownerId: org.ownerUserId, createdAt: { $gte: since } } },
    { $group: { _id: '$source', n: { $sum: 1 } } },
    { $sort: { n: -1 } },
  ]);
  const formUrl = `${env.clientUrl.replace(/\/+$/, '')}/f/${key}`;
  return {
    key,
    autoWhatsapp: org.leadCapture?.autoWhatsapp !== false,
    hostedFormUrl: formUrl,
    webhookUrl: inboundUrl,
    googleAds: { webhookUrl: `${base}/api/inbound/google-ads/${key}`, key },
    forwardingEmail: inboundDomain ? `leads-${key}@${inboundDomain}` : null,
    embedSnippet: [
      `<form action="${inboundUrl}" method="POST">`,
      '  <input name="name" placeholder="Aapka naam" required>',
      '  <input name="phone" placeholder="Mobile number" required>',
      '  <input name="email" type="email" placeholder="Email (optional)">',
      '  <input name="project" type="hidden" value="">',
      '  <input name="website" style="display:none" tabindex="-1" autocomplete="off">',
      '  <input name="redirect" type="hidden" value="https://yourwebsite.com/thank-you">',
      '  <button type="submit">Enquire now</button>',
      '</form>',
    ].join('\n'),
    meta: {
      connected: Boolean(org.leadCapture?.metaPageId),
      pageId: org.leadCapture?.metaPageId || null,
      pageName: org.leadCapture?.metaPageName || null,
      connectedAt: org.leadCapture?.metaConnectedAt || null,
      appId: env.platformMeta.appId || null,
      apiVersion: env.platformMeta.apiVersion,
    },
    last30Days: bySource.map((r) => ({ source: r._id || 'manual', count: r.n })),
  };
}

const getLeadSources = asyncHandler(async (req, res) => {
  return new ApiResponse(200, { sources: await sourcesView(req, req.org._id) }).send(res);
});

const updateLeadSources = asyncHandler(async (req, res) => {
  const $set = {};
  if (typeof req.body.autoWhatsapp === 'boolean') $set['leadCapture.autoWhatsapp'] = req.body.autoWhatsapp;
  if (req.body.regenerateKey) $set['leadCapture.key'] = newKey();
  if (Object.keys($set).length) await Organization.updateOne({ _id: req.org._id }, { $set });
  orgService.invalidate(req.org._id);
  return new ApiResponse(200, { sources: await sourcesView(req, req.org._id) }, req.body.regenerateKey ? 'Naya link ban gaya — purane form band ho gaye' : 'Saved').send(res);
});

const metaPages = asyncHandler(async (req, res) => {
  const pages = await metaLeadAds.listPages(req.org._id, req.body.userAccessToken);
  return new ApiResponse(200, { pages }).send(res);
});

const metaConnect = asyncHandler(async (req, res) => {
  const page = await metaLeadAds.connectPage(req.org._id, req.body);
  await AuditLog.create({ userId: req.user.actorId, action: 'org.meta_leads.connect', meta: { pageId: page.pageId }, ip: req.ip });
  return new ApiResponse(200, { sources: await sourcesView(req, req.org._id) }, `${page.pageName || 'Page'} connected — ab Facebook/Instagram lead form ki leads seedhe PropAI mein aayengi`).send(res);
});

const metaDisconnect = asyncHandler(async (req, res) => {
  await metaLeadAds.disconnectPage(req.org._id);
  return new ApiResponse(200, { sources: await sourcesView(req, req.org._id) }, 'Page disconnected').send(res);
});

/* ---------------- Routing ---------------- */

async function routingView(orgId) {
  const org = await Organization.findById(orgId).lean();
  const team = await User.find({ orgId, isActive: true }).select('name orgRole').sort({ createdAt: 1 }).lean();
  const counts = await Lead.aggregate([
    { $match: { ownerId: org.ownerUserId, assignedTo: { $ne: null } } },
    { $group: { _id: '$assignedTo', n: { $sum: 1 } } },
  ]);
  return {
    mode: org.routing?.mode || 'off',
    agentIds: (org.routing?.agentIds || []).map(String),
    agentsSeeOnlyAssigned: !!org.routing?.agentsSeeOnlyAssigned,
    team: team.map((u) => ({ id: String(u._id), name: u.name, orgRole: u.orgRole, assignedLeads: counts.find((c) => String(c._id) === String(u._id))?.n || 0 })),
    unassigned: await Lead.countDocuments({ ownerId: org.ownerUserId, assignedTo: null }),
  };
}

const getRouting = asyncHandler(async (req, res) => new ApiResponse(200, { routing: await routingView(req.org._id) }).send(res));

const updateRouting = asyncHandler(async (req, res) => {
  const $set = {};
  if (req.body.mode) $set['routing.mode'] = req.body.mode;
  if (Array.isArray(req.body.agentIds)) {
    const valid = await User.find({ _id: { $in: req.body.agentIds }, orgId: req.org._id }).select('_id').lean();
    $set['routing.agentIds'] = valid.map((u) => u._id);
  }
  if (typeof req.body.agentsSeeOnlyAssigned === 'boolean') $set['routing.agentsSeeOnlyAssigned'] = req.body.agentsSeeOnlyAssigned;
  await Organization.updateOne({ _id: req.org._id }, { $set });
  orgService.invalidate(req.org._id);
  return new ApiResponse(200, { routing: await routingView(req.org._id) }, 'Routing saved').send(res);
});

/** POST /api/org/routing/assign { leadIds, userId|null } — manual (bulk) assign. */
const assignLeads = asyncHandler(async (req, res) => {
  let user = null;
  if (req.body.userId) {
    user = await User.findOne({ _id: req.body.userId, orgId: req.org._id, isActive: true }).select('_id name').lean();
    if (!user) throw ApiError.badRequest('Team member not found');
  }
  const leads = await Lead.find({ ownerId: req.org.ownerUserId, _id: { $in: req.body.leadIds } }).select('_id name ownerId source').lean();
  for (const lead of leads) await assignLead(lead, user, { notify: leads.length === 1 });
  return new ApiResponse(200, { assigned: leads.length }, user ? `${leads.length} lead(s) ${user.name} ko assign` : `${leads.length} lead(s) unassigned`).send(res);
});

/** POST /api/org/routing/distribute — round-robin all unassigned leads now. */
const distributeUnassigned = asyncHandler(async (req, res) => {
  const users = await eligibleUsers(req.org);
  if (!users.length) throw ApiError.badRequest('Pehle team mein agent add karein');
  const leads = await Lead.find({ ownerId: req.org.ownerUserId, assignedTo: null }).select('_id name ownerId').limit(5000).lean();
  let i = 0;
  for (const lead of leads) {
    await assignLead(lead, users[i % users.length], { notify: false });
    i += 1;
  }
  return new ApiResponse(200, { assigned: leads.length }, `${leads.length} leads ${users.length} logon mein baant di`).send(res);
});

/* ---------------- Weekly report ---------------- */
const updateWeeklyReport = asyncHandler(async (req, res) => {
  const $set = {};
  if (typeof req.body.enabled === 'boolean') $set['weeklyReport.enabled'] = req.body.enabled;
  if (req.body.phone !== undefined) $set['weeklyReport.phone'] = req.body.phone || null;
  await Organization.updateOne({ _id: req.org._id }, { $set });
  orgService.invalidate(req.org._id);
  const org = await Organization.findById(req.org._id).select('weeklyReport').lean();
  return new ApiResponse(200, { weeklyReport: org.weeklyReport }, 'Saved').send(res);
});

/* ---------------- Requests to PropAI ---------------- */
const createRequest = asyncHandler(async (req, res) => {
  const r = await PlatformRequest.create({ orgId: req.org._id, userId: req.user.actorId, ...req.body });
  return new ApiResponse(201, { request: r }, 'Request PropAI team ko bhej di — jald contact karenge').send(res);
});

const listMyRequests = asyncHandler(async (req, res) => {
  const items = await PlatformRequest.find({ orgId: req.org._id }).sort({ createdAt: -1 }).limit(50).lean();
  return new ApiResponse(200, { items }).send(res);
});

module.exports = {
  getLeadSources,
  updateLeadSources,
  metaPages,
  metaConnect,
  metaDisconnect,
  getRouting,
  updateRouting,
  assignLeads,
  distributeUnassigned,
  updateWeeklyReport,
  createRequest,
  listMyRequests,
};
