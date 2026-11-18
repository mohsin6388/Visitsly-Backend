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
  const org = await Organization.findById(req.org._id).select('voice usage country currency').lean();
  const v = org.voice || {};
  const country = org.country || 'IN';
  const agent = platformVoice.resolve({ country });
  const currency = pricingLib.supported(org.currency) ? org.currency : pricingLib.currencyForCountry(country);
  const perMinute = pricingLib.addonPrice('voiceMinute', currency);
  const tax = pricingLib.taxRate(currency);
  const minutes = orgService.usageFor(org).voiceMinutes || 0;
  return {
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
    costThisMonth: perMinute != null ? Math.round(minutes * perMinute * 100) / 100 : null,
    autoCallNewLeads: !!v.autoCallNewLeads,
    autoCallAfterMinutes: v.autoCallAfterMinutes || 30,
  };
}

const getSettings = asyncHandler(async (req, res) => new ApiResponse(200, { voice: await settingsView(req) }).send(res));

const updateSettings = asyncHandler(async (req, res) => {
  const $set = {};
  for (const k of ['autoCallNewLeads', 'autoCallAfterMinutes']) if (req.body[k] !== undefined) $set[`voice.${k}`] = req.body[k];
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
  const result = await voice.testCall(phone);
  return new ApiResponse(200, { result }, 'Test call on its way — your phone will ring within a minute').send(res);
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
      case 'turn':
        return sendXml(res, await voice.onTurn(log, params));
      case 'noinput':
        return sendXml(res, await voice.onNoInput(log));
      case 'fallback':
        logger.warn('[voice] Plivo used the fallback URL', { call: callId, params });
        // First time: keep the call alive on keypad input (1 / 2). If that fails too, apologise + WhatsApp.
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

module.exports = { getSettings, updateSettings, callLead, listCalls, testCall, plivoWebhook, audio };
