const crypto = require('crypto');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const Organization = require('../models/Organization');
const Lead = require('../models/Lead');
const CallLog = require('../models/CallLog');
const orgService = require('../services/saas/orgService');
const voice = require('../services/voice/voiceService');
const tts = require('../services/voice/tts');
const plivo = require('../services/voice/plivoClient');
const pricingLib = require('../config/pricing');
const platformVoice = require('../config/voiceAgents');
const logger = require('../utils/logger');

/** What the Visit confirmation page needs: availability, language, price per minute and this month's usage. */
async function settingsView(req) {
  const org = await Organization.findById(req.org._id).select('voice usage country currency plan status limitOverrides featureOverrides addonGrants').lean();
  const queue = await Lead.aggregate([
    { $match: { ownerId: req.org.ownerUserId, 'aiCall.status': { $in: ['queued', 'calling'] } } },
    { $group: { _id: '$aiCall.status', n: { $sum: 1 } } },
  ]).catch(() => []);
  const queueCount = Object.fromEntries(queue.map((q) => [q._id, q.n]));
  const v = org.voice || {};
  const country = org.country || 'IN';
  const agent = platformVoice.resolve({ country });
  const currency = require('../services/saas/billingService').currencyOf(org);
  const perMinute = pricingLib.addonPrice('voiceMinute', currency);
  const tax = pricingLib.taxRate(currency);
  const minutes = orgService.usageFor(org).voiceMinutes || 0;
  // Included minutes (plan + prepaid packs); only minutes beyond them are billed per minute.
  const usage = require('../services/saas/subscription').voiceUsage(org);
  const plan = require('../config/plans').cheapestPlanWith('aiCalling');
  return {
    // false on the free trial (and any plan without AI calling): show the upgrade prompt.
    planAllows: usage.enabled,
    upgradePlan: usage.enabled ? null : plan?.code || null,
    includedMinutes: usage.includedMinutes,
    prepaidMinutes: usage.prepaidMinutes,
    remainingIncludedMinutes: usage.remainingIncluded,
    overageMinutes: usage.overageMinutes,
    overageCost: perMinute != null ? Math.round(usage.overageMinutes * perMinute * 100) / 100 : null,
    available: Boolean(agent),
    language: agent?.language || platformVoice.COUNTRY_LANG[country] || 'en',
    languageLabel: agent?.languageLabel || null,
    voice: agent ? (agent.tts ? 'elevenlabs' : 'plivo') : null,
    pricing: {
      currency,
      perMinute,
      taxRate: tax,
      perMinuteWithTax: perMinute != null ? pricingLib.withTax(perMinute, currency) : null,
    },
    minutesThisMonth: minutes,
    // Billed = minutes beyond the included ones.
    costThisMonth: perMinute != null ? Math.round(usage.overageMinutes * perMinute * 100) / 100 : null,
    autoCallNewLeads: !!v.autoCallNewLeads,
    autoCallAfterMinutes: v.autoCallAfterMinutes || 30,
    // Optional company script for lead calls (empty = default AI assistant script).
    script: v.script || '',
    queue: { queued: queueCount.queued || 0, calling: queueCount.calling || 0 },
  };
}

const getSettings = asyncHandler(async (req, res) => new ApiResponse(200, { voice: await settingsView(req) }).send(res));

const updateSettings = asyncHandler(async (req, res) => {
  const $set = {};
  for (const k of ['autoCallNewLeads', 'autoCallAfterMinutes']) if (req.body[k] !== undefined) $set[`voice.${k}`] = req.body[k];
  if (req.body.script !== undefined) $set['voice.script'] = String(req.body.script || '').trim().slice(0, 4000);
  if (req.body.autoCallNewLeads === true) $set['voice.enabled'] = true;
  if (Object.keys($set).length) await Organization.updateOne({ _id: req.org._id }, { $set });
  orgService.invalidate(req.org._id);
  return new ApiResponse(200, { voice: await settingsView(req) }, 'AI calling settings saved').send(res);
});

const callLead = asyncHandler(async (req, res) => {
  const lead = await Lead.findOne({ _id: req.params.leadId, ownerId: req.user.id });
  if (!lead) throw ApiError.notFound('Lead not found');
  const log = await voice.placeCall(lead, { requestedBy: req.user.actorId });
  return new ApiResponse(201, { call: log }, `Calling ${lead.name} with AI`).send(res);
});

const testCall = asyncHandler(async (req, res) => {
  const phone = req.body.phone || req.user.phone;
  const result = await voice.testCall(phone, { kind: req.body.kind === 'lead' ? 'lead' : 'visit' });
  return new ApiResponse(200, { result }, 'Test call on its way — your phone will ring within a minute').send(res);
});

/** GET /api/voice/history?section=visits|leads&days=30&result=all|answered|missed */
const history = asyncHandler(async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  const result = ['answered', 'missed', 'in_progress'].includes(req.query.result) ? req.query.result : 'all';
  const section = req.query.section === 'leads' ? 'leads' : 'visits';
  const data = await require('../services/visits/visitConfirmation').callsList({ days, result, section, limit: req.query.limit });
  return new ApiResponse(200, data).send(res);
});

const SECTION_TRIGGERS = { visits: ['visit_confirmation', 'visit_reminder'], leads: ['manual', 'auto_new_lead', 'bulk'] };

/** DELETE /api/voice/history/:id — remove one call from the history (billing usage is not changed). */
const deleteCall = asyncHandler(async (req, res) => {
  const log = await CallLog.findOneAndDelete({ _id: req.params.id, ownerId: req.user.id, status: { $nin: ['queued', 'ringing', 'in-progress'] } });
  if (!log) throw ApiError.notFound('Call not found, or it is still in progress');
  return new ApiResponse(200, { deleted: 1 }, 'Call deleted').send(res);
});

/** DELETE /api/voice/history?section=visits|leads — clear the call history of one section. */
const clearHistory = asyncHandler(async (req, res) => {
  const section = req.query.section === 'leads' ? 'leads' : 'visits';
  const result = await CallLog.deleteMany({
    ownerId: req.user.id,
    trigger: { $in: SECTION_TRIGGERS[section] },
    $or: [{ finalizedAt: { $ne: null } }, { createdAt: { $lt: new Date(Date.now() - 30 * 60 * 1000) } }],
  });
  return new ApiResponse(200, { deleted: result.deletedCount }, `${result.deletedCount} calls deleted`).send(res);
});

/**
 * GET /api/voice/leads?state=to_call|queued|all&search=&page=
 * Contacts from Upload Data with a phone number, and where each stands in the AI calling queue.
 * to_call = never called by AI and not in the queue.
 */
const callableLeads = asyncHandler(async (req, res) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const filter = { ownerId: req.user.id, phone: { $type: 'string', $ne: '' }, optedOut: { $ne: true } };
  if (req.query.state === 'queued') filter['aiCall.status'] = { $in: ['queued', 'calling'] };
  else if (req.query.state !== 'all') filter.$or = [{ 'aiCall.status': null }, { 'aiCall.status': { $exists: false } }, { 'aiCall.status': 'cancelled' }];
  const q = String(req.query.search || '').trim().slice(0, 80);
  if (q) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$and = [{ $or: [{ name: rx }, { phone: rx }, { email: rx }] }];
  }
  const [items, total] = await Promise.all([
    Lead.find(filter).sort({ 'aiCall.queuedAt': -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).select('name phone email source createdAt aiCall leadScore status').lean(),
    Lead.countDocuments(filter),
  ]);
  return new ApiResponse(200, { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) }).send(res);
});

/** POST /api/voice/queue { leadIds } — add contacts to the AI calling queue (called one by one in calling hours). */
const queueLeads = asyncHandler(async (req, res) => {
  const ids = [...new Set((req.body.leadIds || []).map(String))].slice(0, voice.BULK_BATCH_MAX);
  const result = await Lead.updateMany(
    { _id: { $in: ids }, ownerId: req.user.id, phone: { $type: 'string', $ne: '' }, optedOut: { $ne: true }, 'aiCall.status': { $nin: ['queued', 'calling'] } },
    { $set: { 'aiCall.status': 'queued', 'aiCall.queuedAt': new Date(), 'aiCall.error': null, 'aiCall.outcome': null, 'aiCall.nextCallAt': null, 'aiCall.reason': null, 'aiCall.retries': 0 } },
  );
  const AuditLog = require('../models/AuditLog');
  await AuditLog.create({ userId: req.user.actorId || req.user.id, action: 'voice.queue', meta: { requested: ids.length, queued: result.modifiedCount }, ip: req.ip }).catch(() => {});
  const skipped = ids.length - result.modifiedCount;
  return new ApiResponse(200, { queued: result.modifiedCount, skipped }, `${result.modifiedCount} contact${result.modifiedCount === 1 ? '' : 's'} added to AI calling${skipped ? ` (${skipped} skipped: already queued, opted out or no number)` : ''}. Calls go out one by one during calling hours.`).send(res);
});

/** POST /api/voice/queue/cancel { leadIds? } — take contacts out of the queue (all queued when no ids). */
const cancelQueue = asyncHandler(async (req, res) => {
  const filter = { ownerId: req.user.id, 'aiCall.status': 'queued' };
  if (Array.isArray(req.body.leadIds) && req.body.leadIds.length) filter._id = { $in: req.body.leadIds.map(String) };
  const result = await Lead.updateMany(filter, { $set: { 'aiCall.status': 'cancelled' } });
  return new ApiResponse(200, { cancelled: result.modifiedCount }, `${result.modifiedCount} removed from the calling queue`).send(res);
});

const listCalls = asyncHandler(async (req, res) => {
  const filter = { ownerId: req.user.id, trigger: { $ne: 'test' } };
  if (req.query.leadId) filter.leadId = req.query.leadId;
  const items = await CallLog.find(filter).sort({ createdAt: -1 }).limit(100).select('-context').populate('leadId', 'name phone').lean();
  return new ApiResponse(200, { items }).send(res);
});

/* ---------------- Plivo callbacks (public) ---------------- */

const safeEq = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function sendXml(res, xml) {
  res.set('Content-Type', 'text/xml; charset=utf-8');
  return res.status(200).send(xml);
}

/** Polite exit used whenever something goes wrong mid-call (the WhatsApp fallback follows). */
function sorryXml(language = 'hi') {
  const text = language === 'en' || language === 'ar'
    ? 'Sorry, we are facing a small technical issue. We will message you on WhatsApp. Thank you!'
    : 'माफ़ कीजिए, अभी थोड़ी तकनीकी दिक्कत है। हम आपको WhatsApp पर message करेंगे। धन्यवाद!';
  return plivo.hangupXml({ say: { text }, language });
}

/**
 * POST /api/webhooks/voice/plivo/:event/:callId?s=<VOICE_WEBHOOK_SECRET>
 * events: answer | turn | noinput | hangup | fallback
 */
const plivoWebhook = async (req, res) => {
  const { event, callId } = req.params;
  const params = { ...(req.query || {}), ...(req.body || {}) };
  const secret = platformVoice.webhookSecret();
  if (secret && !safeEq(req.query.s, secret)) {
    logger.warn('[voice] webhook with bad secret', { event });
    return res.sendStatus(401);
  }
  if (!/^[a-f\d]{24}$/i.test(String(callId || ''))) return res.sendStatus(404);
  const log = await CallLog.findById(callId).catch(() => null);
  if (!log) return event === 'hangup' ? res.sendStatus(200) : sendXml(res, plivo.hangupXml());
  const language = log.context?.language || 'hi';

  try {
    switch (event) {
      case 'answer':
        return sendXml(res, await voice.onAnswer(log, params));
      case 'classic':
        // Live audio stream could not connect: continue this call on the classic engine.
        return sendXml(res, await voice.onAnswer(log, params, { classic: true }));
      case 'turn':
        return sendXml(res, await voice.onTurn(log, params));
      case 'reply':
        return sendXml(res, await voice.onReply(log));
      case 'noinput':
        return sendXml(res, await voice.onNoInput(log));
      case 'fallback':
        logger.warn('[voice] Plivo used the fallback URL', { call: callId, engine: log.context?.engine, params });
        // 1) live-audio call that failed → retry the SAME call as a normal spoken conversation (speech recognition).
        //    2) that failed too → keypad (1 / 2).  3) still failing → apologise + WhatsApp.
        if (log.context?.engine === 'realtime' && !log.context?.fallbackTried) {
          log.context = { ...log.context, fallbackTried: true }; // saved by onAnswer
          log.markModified('context');
          return sendXml(res, await voice.onAnswer(log, params, { classic: true }));
        }
        if (log.context?.inputMode !== 'dtmf') return sendXml(res, await voice.onFallback(log));
        return sendXml(res, sorryXml(language));
      case 'hangup':
        res.sendStatus(200); // answer Plivo first, then do the slower work
        await voice.onHangup(log, params);
        return undefined;
      default:
        return res.sendStatus(404);
    }
  } catch (err) {
    logger.error('[voice] webhook failed', { event, call: callId, error: err.message });
    if (event === 'hangup') return res.headersSent ? undefined : res.sendStatus(200);
    return sendXml(res, sorryXml(language));
  }
};

/** GET /api/webhooks/voice/audio/:file — ElevenLabs clip played by Plivo. */
const audio = async (req, res) => {
  try {
    const id = String(req.params.file || '').replace(/\.mp3$/i, '');
    const clip = await tts.getClip(id);
    if (!clip) return res.sendStatus(404);
    const buf = Buffer.from(clip.data.buffer || clip.data);
    res.set({ 'Content-Type': clip.contentType || 'audio/mpeg', 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=86400' });
    return res.status(200).send(buf);
  } catch (err) {
    logger.warn('[voice] audio serve failed', { error: err.message });
    return res.sendStatus(500);
  }
};

module.exports = { getSettings, updateSettings, callLead, listCalls, history, deleteCall, clearHistory, callableLeads, queueLeads, cancelQueue, testCall, plivoWebhook, audio };
