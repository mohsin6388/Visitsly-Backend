const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const Organization = require('../models/Organization');
const Lead = require('../models/Lead');
const CallLog = require('../models/CallLog');
const { encrypt } = require('../utils/crypto');
const orgService = require('../services/saas/orgService');
const tenantContext = require('../context/tenantContext');
const { orgByCaptureKey, ensureCaptureKey } = require('../services/leads/leadCapture');
const voice = require('../services/voice/voiceService');
const logger = require('../utils/logger');

const publicBase = (req) => (process.env.PUBLIC_API_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '').replace(/\/api$/, '');

async function settingsView(req) {
  const key = await ensureCaptureKey(req.org._id);
  const org = await Organization.findById(req.org._id).select('+voice.apiKeyEncrypted voice usage').lean();
  const v = org.voice || {};
  return {
    enabled: !!v.enabled,
    provider: v.provider || 'bolna',
    apiKeySet: Boolean(v.apiKeyEncrypted),
    agentId: v.agentId || '',
    fromNumber: v.fromNumber || '',
    autoCallNewLeads: !!v.autoCallNewLeads,
    autoCallAfterMinutes: v.autoCallAfterMinutes || 30,
    webhookUrl: `${publicBase(req)}/api/webhooks/voice/${key}`,
    minutesThisMonth: orgService.usageFor(org).voiceMinutes || 0,
  };
}

const getSettings = asyncHandler(async (req, res) => new ApiResponse(200, { voice: await settingsView(req) }).send(res));

const updateSettings = asyncHandler(async (req, res) => {
  const $set = {};
  for (const k of ['enabled', 'agentId', 'fromNumber', 'autoCallNewLeads', 'autoCallAfterMinutes']) if (req.body[k] !== undefined) $set[`voice.${k}`] = req.body[k];
  if (req.body.apiKey) $set['voice.apiKeyEncrypted'] = encrypt(req.body.apiKey);
  await Organization.updateOne({ _id: req.org._id }, { $set });
  orgService.invalidate(req.org._id);
  return new ApiResponse(200, { voice: await settingsView(req) }, 'AI calling settings saved').send(res);
});

const callLead = asyncHandler(async (req, res) => {
  const lead = await Lead.findOne({ _id: req.params.leadId, ownerId: req.user.id });
  if (!lead) throw ApiError.notFound('Lead not found');
  const log = await voice.placeCall(lead, { requestedBy: req.user.actorId, publicBase: publicBase(req) });
  return new ApiResponse(201, { call: log }, `${lead.name} ko AI call lag rahi hai`).send(res);
});

const listCalls = asyncHandler(async (req, res) => {
  const filter = { ownerId: req.user.id };
  if (req.query.leadId) filter.leadId = req.query.leadId;
  const items = await CallLog.find(filter).sort({ createdAt: -1 }).limit(100).populate('leadId', 'name phone').lean();
  return new ApiResponse(200, { items }).send(res);
});

/** POST /api/webhooks/voice/:key — Bolna execution webhook (public; capture key authenticates). */
const webhook = async (req, res) => {
  try {
    const org = await orgByCaptureKey(req.params.key);
    if (!org) return res.sendStatus(404);
    await tenantContext.run(org, () => voice.handleExecution(org, req.body || {}));
    return res.json({ ok: true });
  } catch (err) {
    logger.error('[voice] webhook failed', { error: err.message });
    return res.sendStatus(500);
  }
};

module.exports = { getSettings, updateSettings, callLead, listCalls, webhook };
