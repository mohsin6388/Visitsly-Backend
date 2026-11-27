const Organization = require('../../models/Organization');
const Lead = require('../../models/Lead');
const Message = require('../../models/Message');
const Meeting = require('../../models/Meeting');
const Conversation = require('../../models/Conversation');
const FollowUp = require('../../models/FollowUp');
const CallLog = require('../../models/CallLog');
const Notification = require('../../models/Notification');
const platformVoice = require('../../config/voiceAgents');
const plivo = require('./plivoClient');
const tts = require('./tts');
const agent = require('./voiceAgent');
const realtime = require('./realtime/streamServer');
const ApiError = require('../../utils/ApiError');
const tenantContext = require('../../context/tenantContext');
const orgService = require('../saas/orgService');
const callPolicy = require('./callPolicy');
const postCall = require('./postCall');
const logger = require('../../utils/logger');

/**
 * Follow-up draft after a call, in the customer's saved chat language (E5);
 * a customer who never wrote gets the company default / region language.
 */
async function followUpTextFor(lead, key) {
  const lang = require('../language');
  try {
    const conv = await Conversation.findOne({ leadId: lead._id }).select('language').lean();
    const settings = await require('../settings/settingsService').getOrCreateSettings().catch(() => null);
    const region = callPolicy.regionForPhone(lead.phone, tenantContext.getOrg()?.country);
    return lang.t(key, lang.languageFor(conv, { settings, region }), { name: lang.nameVar(lead) });
  } catch {
    return lang.t(key, 'English', { name: lang.nameVar(lead) });
  }
}

/**
 * AI phone calls — PLATFORM MANAGED.
 *
 *   Plivo       → places the call, recognises what the customer says (speech)
 *   ElevenLabs  → the voice the customer hears
 *   Gemini      → decides what to say next (Groq fallback, then simple rules)
 *
 * Call flow (all callbacks are /api/webhooks/voice/plivo/<event>/<callLogId>?s=<secret>):
 *   placeCall → Plivo dials → answer  → opening line + listen
 *                              turn    → customer spoke → agent replies + listen (or ends)
 *                              noinput → silence → ask once more, then end
 *                              hangup  → result saved; visit confirmed / rescheduled / WhatsApp fallback
 */

/* ---------------- helpers ---------------- */

function e164(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length === 10) return `+91${d}`;
  return d ? `+${d}` : null;
}

function base() {
  return platformVoice.publicBase();
}

function hookUrl(event, logId) {
  const secret = platformVoice.webhookSecret();
  return `${base()}/api/webhooks/voice/plivo/${event}/${logId}${secret ? `?s=${encodeURIComponent(secret)}` : ''}`;
}

function audioUrl(id) {
  return id ? `${base()}/api/webhooks/voice/audio/${id}.mp3` : null;
}

/** Company info + the platform voice for a country / language. */
async function voiceConfig(orgId, { language = null, country = null } = {}) {
  const org = await Organization.findById(orgId).select('name country').lean();
  // country = the customer's calling region (IN / AE) when known; each region
  // has its own caller number, hours and languages (see callPolicy.js).
  const c = country || org?.country || 'IN';
  const v = platformVoice.resolve({ country: c, language });
  return { ...(v || {}), available: Boolean(v), companyName: org?.name || '', country: c };
}

function facts(property) {
  if (!property) return '';
  const price = (n) => (n >= 10000000 ? `${(n / 10000000).toFixed(2).replace(/\.?0+$/, '')} crore` : n ? `${Math.round(n / 100000)} lakh` : null);
  return [
    property.projectName && `Project: ${property.projectName}${property.builderName ? ` by ${property.builderName}` : ''}`,
    (property.location || property.city) && `Location: ${[property.location, property.city].filter(Boolean).join(', ')}`,
    property.bhk && `Configuration: ${property.bhk} BHK ${property.propertyType || ''}`.trim(),
    (property.budgetMin || property.budgetMax) && `Price range: ${[price(property.budgetMin), price(property.budgetMax)].filter(Boolean).join(' - ')}`,
    property.possession && `Possession: ${property.possession}`,
    property.amenities?.length && `Amenities: ${property.amenities.slice(0, 8).join(', ')}`,
  ].filter(Boolean).join('\n');
}

/** One line per property for the agent's "OUR PROPERTIES" list. */
function propertyLine(p, i) {
  const price = (n) => (n >= 10000000 ? `${(n / 10000000).toFixed(2).replace(/\.?0+$/, '')} crore` : n ? `${Math.round(n / 100000)} lakh` : null);
  const range = [price(p.budgetMin), price(p.budgetMax)].filter(Boolean).join(' - ');
  // Compact on purpose: a short prompt = a faster first word on the call.
  return `${i + 1}. ${[
    `${p.projectName}${p.builderName ? ` by ${p.builderName}` : ''}`,
    [p.location, p.city].filter(Boolean).join(', '),
    p.bhk && `${p.bhk} BHK${p.propertyType ? ` ${p.propertyType}` : ''}`,
    !p.bhk && p.propertyType,
    range && `price ${range}`,
    p.possession && `possession ${p.possession}`,
    p.amenities?.length && `amenities: ${p.amenities.slice(0, 3).join(', ')}`,
  ].filter(Boolean).join(' · ')}`;
}

/**
 * Everything the WhatsApp assistant knows, for a lead call: the company's
 * available properties (the lead's project first), the lead's profile and
 * the latest WhatsApp messages. Must run inside the tenant context.
 */
async function enquiryContext(lead) {
  const Property = require('../../models/Property');
  const out = { facts: '', leadProfile: '', chat: '', project: lead?.project || '' };
  try {
    const props = await Property.find({ isActive: true, availability: { $nin: ['booked', 'sold'] } })
      .select('projectName builderName location city bhk propertyType budgetMin budgetMax sizeSqft possession nearbyMetro amenities updatedAt')
      .sort({ updatedAt: -1 })
      .limit(40)
      .lean();
    const want = String(lead?.project || '').toLowerCase();
    const place = [lead?.city, lead?.location].map((v) => String(v || '').toLowerCase().trim()).filter(Boolean);
    // The lead's own project first, then properties in their city, then the rest — the customer
    // names the city on the call, so the agent needs the whole catalogue (kept compact).
    const rank = (p) => (want && String(p.projectName).toLowerCase() === want ? 0 : place.some((x) => `${p.city || ''} ${p.location || ''}`.toLowerCase().includes(x)) ? 1 : 2);
    const sorted = [...props].sort((a, b) => rank(a) - rank(b));
    const max = Math.max(1, Number(process.env.VOICE_LEAD_PROPERTIES || 20));
    out.facts = sorted.slice(0, max).map(propertyLine).join('\n');
    if (!out.project && sorted.length === 1) out.project = sorted[0].projectName;
  } catch (err) {
    logger.warn('[voice] could not load properties for the call', { error: err.message });
  }
  if (lead) {
    const price = (n) => (n >= 10000000 ? `${(n / 10000000).toFixed(2).replace(/\.?0+$/, '')} crore` : n ? `${Math.round(n / 100000)} lakh` : null);
    const budget = [price(lead.budgetMin), price(lead.budgetMax)].filter(Boolean).join(' - ');
    out.leadProfile = [
      lead.project && `Interested in: ${lead.project}`,
      lead.requirements && `Requirement: ${lead.requirements}`,
      budget && `Budget: ${budget}`,
      (lead.location || lead.city) && `Location: ${[lead.location, lead.city].filter(Boolean).join(', ')}`,
      lead.occupation && `Occupation: ${lead.occupation}`,
      lead.source && `Came from: ${String(lead.source).replace(/_/g, ' ')}${lead.sourceDetail ? ` (${lead.sourceDetail})` : ''}`,
    ].filter(Boolean).join('\n');
    if (lead._id) {
      const msgs = await Message.find({ leadId: lead._id, text: { $nin: [null, ''] } })
        .sort({ createdAt: -1 })
        .limit(Math.max(0, Number(process.env.VOICE_LEAD_CHAT_MESSAGES || 8)))
        .select('direction text createdAt')
        .lean()
        .catch(() => []);
      out.chat = msgs.reverse().map((m) => `${m.direction === 'inbound' ? 'Customer' : 'Us'}: ${String(m.text).replace(/\s+/g, ' ').slice(0, 220)}`).join('\n');
    }
  }
  return out;
}

/** Generates the clip for a sentence (null → Plivo voice fallback). */
async function speak(ctx, text, { timeoutMs = Number(process.env.ELEVENLABS_LIVE_TIMEOUT_MS || 3000) } = {}) {
  const cfg = platformVoice.elevenLabs(ctx.language);
  const id = cfg ? await tts.synthesize(cfg, text, ctx.language, { timeoutMs }) : null;
  return { audioUrl: audioUrl(id), text };
}

/**
 * Picks the call engine and pre-generates the opening line so the customer
 * hears the agent the moment they pick up.
 *   realtime → live audio stream (listens while speaking, ~1 s replies, can be interrupted)
 *   classic  → Plivo speech prompts turn by turn (fallback)
 */
async function prepareOpening(log, ctx, opening) {
  let engine = realtime.enabled(ctx.language) ? 'realtime' : 'classic';
  if (engine === 'realtime') {
    const ready = await require('./realtime/session').prepare({ ...ctx, opening }).catch(() => false);
    if (!ready) {
      logger.warn('[voice] ElevenLabs could not voice the opening line — using the classic engine for this call', { call: String(log._id) });
      engine = 'classic';
    }
  }
  const extra = { engine };
  if (engine === 'classic') {
    const first = await speak(ctx, opening, { timeoutMs: 9000 });
    extra.openingAudioUrl = first.audioUrl;
    warmFillers(ctx); // short acknowledgements ready before the customer answers
  }
  log.context = { ...log.context, ...extra };
  log.markModified('context');
  return engine;
}

/* ---------------- placing calls ---------------- */

// placeCall refusals that are about the company's calling state, not about one customer: never mark a lead failed for these.
const CALL_BLOCKED = ['VOICE_MINUTES_EXHAUSTED', 'VOICE_PAUSED'];

/** Longest a call may run: its normal limit, but never past the minutes the company has left. */
function callTimeLimit(baseSeconds, minutesLeft) {
  return Number.isFinite(minutesLeft) ? Math.min(baseSeconds, Math.max(60, Math.floor(minutesLeft) * 60)) : baseSeconds;
}

/**
 * Places an AI call to a lead. Must run inside the company's tenant context.
 * meeting → visit-confirmation call; otherwise an enquiry call.
 */
async function placeCall(lead, { trigger = 'manual', requestedBy = null, meeting = null, reminder = false } = {}) {
  const org = tenantContext.getOrg();
  if (!org) throw new Error('placeCall needs a tenant context');
  const { subscriptionState, assertFeature } = require('../saas/subscription');
  if (!subscriptionState(org).active) throw ApiError.forbidden('Subscription is not active');
  // Never free: paid plans only (blocks the trial, incl. auto-calls and visit-confirmation calls).
  assertFeature('aiCalling', org);
  // Monthly plan minutes + recharged minutes finished → no more calls (nothing is
  // created and Plivo / ElevenLabs are not touched). Unlimited companies are never blocked.
  const { voiceUsage, voiceExhaustedError, voicePausedError } = require('../saas/subscription');
  const live = await orgService.withFreshVoice(org);
  if (live.voice?.paused) throw voicePausedError(); // the client switched all AI calling off
  const minutes = voiceUsage(live);
  if (minutes && !minutes.unlimited && minutes.remainingIncluded <= 0) throw voiceExhaustedError();
  const minutesLeft = !minutes || minutes.unlimited ? Infinity : minutes.remainingIncluded;
  const missing = platformVoice.missing();
  if (missing.length) throw ApiError.badRequest(`AI calling is not set up (${missing.join(', ')} missing).`);

  const conv = await Conversation.findOne({ leadId: lead._id }).select('language').lean();
  // Region (India / UAE), STOP, calling hours and India DND — one place for every kind of call.
  // Manual "Call now" skips only the hours check; DND applies to lead (sales) calls,
  // not to confirming a visit the customer booked.
  const callSettings = await require('../settings/settingsService').getOrCreateSettings().catch(() => null);
  const allowed = await callPolicy.canCall(lead, {
    settings: meeting ? { ...(callSettings?.toObject?.() || callSettings || {}), calling: { dnd: { enabled: false } } } : callSettings,
    orgCountry: org.country,
    checkHours: !['manual'].includes(trigger),
  });
  if (!allowed.ok) {
    await Lead.updateOne({ _id: lead._id }, { $set: { 'aiCall.error': allowed.reason } }).catch(() => {});
    throw ApiError.badRequest(allowed.reason);
  }
  const region = allowed.region;
  // E5: the call is in the customer's saved chat language. If the call agent
  // can't speak it, no call in another language — WhatsApp handles it instead.
  const langInfo = callPolicy.callLanguageInfo(region, conv?.language);
  if (!langInfo.supported) {
    const reason = `AI calls are not available in ${langInfo.language} yet (the customer's chat language) — contact them on WhatsApp instead`;
    await Lead.updateOne({ _id: lead._id }, { $set: { 'aiCall.error': reason } }).catch(() => {});
    throw ApiError.badRequest(reason, { code: 'CALL_LANGUAGE_UNSUPPORTED', language: langInfo.language });
  }
  const cfg = await voiceConfig(org._id, { language: langInfo.code, country: region });
  if (!cfg.available) throw ApiError.badRequest(region === 'AE' ? 'AI calling for UAE numbers is not set up yet (no UAE caller number).' : 'AI calling is not available yet. Please contact support.');
  const to = e164(lead.phone);
  if (!to) throw ApiError.badRequest('Lead has no phone number');

  let property = null;
  if (meeting?.propertyId) {
    property = meeting.propertyId?.projectName ? meeting.propertyId : await require('../../models/Property').findById(meeting.propertyId).lean();
  }
  const project = property?.projectName || lead.project || '';
  const purpose = meeting ? (reminder ? 'visit_reminder' : 'visit_confirmation') : 'enquiry';
  const tentative = Boolean(meeting?.dateTentative);
  // Lead calls follow the company's own script when it set one.
  const script = purpose === 'enquiry' ? String((await Organization.findById(org._id).select('voice.script').lean())?.voice?.script || '').trim() : '';
  // Lead call: same knowledge as the WhatsApp assistant (properties, profile, chat).
  const known = purpose === 'enquiry' ? await enquiryContext(lead) : null;
  // Contact from Upload Data (never enquired) vs. a real enquiry (form / ad / portal / WhatsApp).
  const cold = purpose === 'enquiry' && ['csv_import', 'manual', 'upload', 'import'].includes(String(lead.source || '').toLowerCase()) && !lead.project;
  const ctx = {
    purpose,
    orgId: String(org._id),
    name: lead.name || '',
    company: cfg.companyName,
    cold,
    project,
    requirement: lead.requirements || '',
    visitDate: meeting?.preferredDate || null,
    visitTime: meeting?.preferredTime || null,
    visitDay: meeting ? platformVoice.spokenDate(meeting.preferredDate, 'en') : null,
    tentative,
    language: cfg.language,
    sttLanguage: cfg.sttLanguage,
    // The customer's chat language is saved → the call never asks about the language.
    chatLanguage: langInfo.saved ? langInfo.language : null,
    region,
    facts: known ? known.facts : facts(property),
    leadProfile: known?.leadProfile || '',
    chat: known?.chat || '',
    script,
  };
  const opening = reminder && meeting
    ? platformVoice.reminderScript(cfg.language, { name: lead.name, project, time: meeting.preferredTime, company: cfg.companyName })
    : meeting
    ? platformVoice.confirmationScript(cfg.language, { name: lead.name, project, date: meeting.preferredDate, time: meeting.preferredTime, company: cfg.companyName, tentative })
    : platformVoice.enquiryScript(cfg.language, { name: lead.name, project, company: cfg.companyName, cold, hasScript: Boolean(script), askLanguage: !langInfo.saved });

  const log = await CallLog.create({
    ownerId: org.ownerUserId,
    leadId: lead._id,
    trigger,
    requestedBy,
    meetingId: meeting?._id || null,
    language: cfg.language,
    purpose,
    toNumber: to,
    fromNumber: cfg.fromNumber,
    context: { ...ctx, opening },
  });

  await prepareOpening(log, ctx, opening);
  try {
    const { requestUuid } = await plivo.makeCall({
      from: cfg.fromNumber,
      to,
      answerUrl: hookUrl('answer', log._id),
      hangupUrl: hookUrl('hangup', log._id),
      // Lead calls are longer conversations. A call can never run past the minutes left.
      timeLimit: callTimeLimit(purpose === 'enquiry' ? 600 : 300, minutesLeft),
    });
    log.executionId = requestUuid;
    log.status = 'queued';
    await log.save();
    logger.info('[voice] Call placed', { call: String(log._id), purpose, to });
    return log;
  } catch (err) {
    log.status = 'failed';
    const rawError = plivo.errorText(err);
    log.error = callPolicy.friendlyCallError({ error: rawError }) || rawError;
    log.finalizedAt = new Date();
    await log.save();
    logger.warn('[voice] Plivo call failed', { call: String(log._id), error: rawError });
    throw ApiError.badRequest(`Call failed: ${log.error}`);
  }
}

/**
 * "Test call" to the owner's own number.
 *   kind "lead"  → a lead call, exactly like a real one (company properties + script)
 *   kind "visit" → a visit-confirmation call with a sample visit tomorrow 11:00
 */
async function testCall(phone, { kind = 'visit' } = {}) {
  const org = tenantContext.getOrg();
  if (!org) throw new Error('testCall needs a tenant context');
  require('../saas/subscription').assertFeature('aiCalling', org);
  const missing = platformVoice.missing();
  if (missing.length) throw ApiError.badRequest(`AI calling is not set up (${missing.join(', ')} missing).`);
  const cfg = await voiceConfig(org._id);
  if (!cfg.available) throw ApiError.badRequest('AI calling is not available yet. Please contact support.');
  const to = e164(phone);
  if (!to) throw ApiError.badRequest('Enter a valid mobile number');
  let ctx;
  let opening;
  if (kind === 'lead') {
    const known = await enquiryContext({ name: '', project: '' });
    const script = String((await Organization.findById(org._id).select('voice.script').lean())?.voice?.script || '').trim();
    ctx = {
      purpose: 'enquiry', orgId: String(org._id), name: '', company: cfg.companyName, cold: true, project: known.project, requirement: '',
      language: cfg.language, sttLanguage: cfg.sttLanguage, facts: known.facts, leadProfile: '', chat: '', script,
    };
    opening = platformVoice.enquiryScript(cfg.language, { name: '', project: known.project, company: cfg.companyName, cold: true, hasScript: Boolean(script) });
  } else {
    const tomorrow = new Date(Date.now() + 330 * 60000 + 86400000).toISOString().slice(0, 10);
    ctx = {
      purpose: 'visit_confirmation', orgId: String(org._id), name: 'Test', company: cfg.companyName, project: 'Sample Project',
      visitDate: tomorrow, visitTime: '11:00', visitDay: platformVoice.spokenDate(tomorrow, 'en'), tentative: false,
      language: cfg.language, sttLanguage: cfg.sttLanguage, facts: 'Project: Sample Project (test call)',
    };
    opening = platformVoice.confirmationScript(cfg.language, { name: '', project: 'Sample Project', date: tomorrow, time: '11:00', company: cfg.companyName });
  }
  const log = await CallLog.create({ ownerId: org.ownerUserId, leadId: null, trigger: 'test', purpose: 'test', language: cfg.language, toNumber: to, fromNumber: cfg.fromNumber, context: { ...ctx, opening } });
  const engine = await prepareOpening(log, ctx, opening);
  try {
    const { requestUuid } = await plivo.makeCall({ from: cfg.fromNumber, to, answerUrl: hookUrl('answer', log._id), hangupUrl: hookUrl('hangup', log._id), timeLimit: kind === 'lead' ? 600 : 300 });
    log.executionId = requestUuid;
    await log.save();
    return { callId: String(log._id), status: 'queued', kind, language: cfg.language, voice: engine === 'realtime' || log.context.openingAudioUrl ? 'elevenlabs' : 'plivo', engine };
  } catch (err) {
    log.status = 'failed';
    log.error = plivo.errorText(err);
    log.finalizedAt = new Date();
    await log.save();
    logger.warn('[voice] test call failed', { error: log.error });
    throw ApiError.badRequest(`Test call failed: ${log.error}`);
  }
}

/* ---------------- Plivo callbacks ---------------- */

/** "speech" normally; "dtmf" once speech recognition failed on this call (or when VOICE_INPUT_MODE=dtmf). */
function inputMode(log) {
  return log.context?.inputMode || (process.env.VOICE_INPUT_MODE === 'dtmf' ? 'dtmf' : 'speech');
}

function listen(log, say) {
  const ctx = log.context || {};
  return plivo.gatherXml({
    actionUrl: hookUrl('turn', log._id),
    noInputUrl: hookUrl('noinput', log._id),
    say,
    sttLanguage: ctx.sttLanguage || 'en-IN',
    language: ctx.language || 'hi',
    mode: inputMode(log),
  });
}

/** Keypad instructions (Plivo's own voice → no ElevenLabs delay, safe inside a fallback response). */
function dtmfPrompt(ctx, { withOpening = false } = {}) {
  const hi = ctx.language === 'hi';
  const keys = ctx.purpose === 'enquiry'
    ? (hi ? 'Site visit plan करने के लिए 1 दबाइए। बाद में बात करने के लिए 2 दबाइए।' : 'To plan a site visit press 1. To talk later press 2.')
    : hi
    ? 'विज़िट confirm करने के लिए 1 दबाइए। तारीख या समय बदलने के लिए 2 दबाइए।'
    : 'To confirm your visit press 1. To change the date or time press 2.';
  const head = withOpening && ctx.opening ? `${ctx.opening} ` : (hi ? 'नमस्ते। ' : 'Hello. ');
  return { text: `${head}${keys}` };
}

/** Plivo could not run the speech prompt → continue the SAME call with keypad input. */
async function onFallback(log) {
  const ctx = { ...(log.context || {}), inputMode: 'dtmf' };
  log.context = ctx;
  log.markModified('context');
  if (!log.answeredAt) log.answeredAt = new Date();
  await log.save();
  return listen(log, dtmfPrompt(ctx));
}

/** Keypad answer → decision without the LLM (1 = confirm, 2 = wants to change → WhatsApp). */
function dtmfDecision(ctx, digit) {
  const hi = ctx.language === 'hi';
  const female = platformVoice.agentGender() === 'female';
  if (ctx.purpose === 'enquiry') {
    // Lead call on keypad: 1 = wants a visit → team follows up on WhatsApp today; 2 = later.
    return digit === '1'
      ? { say: hi ? `बहुत बढ़िया! हमारी टीम आपको WhatsApp पर visit का time fix करने के लिए message ${'करेगी'}। धन्यवाद!` : 'Great! Our team will message you on WhatsApp to fix a time for the visit. Thank you!', end_call: true, visit: 'unknown', interested: true, summary: 'Customer pressed 1 (wants a site visit) on the call.' }
      : { say: hi ? 'कोई बात नहीं, हम आपको WhatsApp पर details भेज देंगे। धन्यवाद!' : 'No problem, we will send you the details on WhatsApp. Thank you!', end_call: true, visit: 'unknown', callback_later: true, summary: 'Customer pressed 2 (talk later) on the call.' };
  }
  if (digit === '1' && !ctx.tentative) {
    return {
      say: hi ? 'बहुत बढ़िया! आपकी site visit confirm है। Location details WhatsApp पर भेज दी जाएँगी। धन्यवाद!' : 'Great! Your site visit is confirmed. We will send the location on WhatsApp. Thank you!',
      end_call: true, visit: 'confirmed', summary: 'Customer ne keypad (1) se visit confirm ki.',
    };
  }
  if (digit === '2') {
    return {
      say: hi ? `ठीक है। मैं आपको WhatsApp पर message ${female ? 'कर देती' : 'कर देता'} हूँ, वहाँ अपना सही दिन और time बता दीजिए। धन्यवाद!` : 'No problem. I will message you on WhatsApp, please share a day and time that suits you there. Thank you!',
      end_call: true, visit: 'declined', summary: 'Customer ne keypad (2) se date/time badalni chahi.',
    };
  }
  return {
    say: hi ? `ठीक है, मैं आपको WhatsApp पर details ${female ? 'भेज देती' : 'भेज देता'} हूँ। धन्यवाद!` : 'Alright, I will send you the details on WhatsApp. Thank you!',
    end_call: true, visit: 'unknown', summary: 'No clear answer on the keypad.',
  };
}

function goodbye(log, say) {
  return plivo.hangupXml({ say, language: log.context?.language || 'hi' });
}

/** Call picked up → opening line, then listen. */
async function onAnswer(log, params, { classic = false } = {}) {
  if (!log.answeredAt) log.answeredAt = new Date();
  if (params.CallUUID) log.callUuid = params.CallUUID;
  log.status = 'in-progress';
  const ctx = log.context || {};
  if (!classic && ctx.engine === 'realtime' && realtime.enabled(ctx.language)) {
    // Plivo waits for this XML: answer first, save in the background (a slow answer_url makes Plivo use the fallback URL).
    const set = { status: 'in-progress', answeredAt: log.answeredAt, ...(log.callUuid ? { callUuid: log.callUuid } : {}) };
    if (!log.turns.length) set.turns = [{ role: 'agent', text: ctx.opening, at: new Date() }];
    CallLog.updateOne({ _id: log._id }, { $set: set }).catch((err) => logger.warn('[voice] answer save failed', { error: err.message }));
    log.status = 'in-progress';
    emitCall(log);
    watchStream(log);
    return plivo.streamXml({ wsUrl: realtime.streamUrl(log._id) });
  }
  if (classic && ctx.engine !== 'classic') {
    log.context = { ...ctx, engine: 'classic' };
    log.markModified('context');
  }
  const forcedDtmf = inputMode(log) === 'dtmf';
  const say = forcedDtmf
    ? dtmfPrompt(ctx, { withOpening: true })
    : ctx.openingAudioUrl ? { audioUrl: ctx.openingAudioUrl, text: ctx.opening } : await speak(ctx, ctx.opening);
  if (!log.turns.length) log.turns.push({ role: 'agent', text: ctx.opening });
  await log.save();
  emitCall(log);
  return listen(log, say);
}

/**
 * Safety net: if the live audio stream does not connect within a few seconds
 * (WebSocket blocked by a proxy, server restarting…) move the call to the
 * classic engine so the customer still gets a working call.
 */
function watchStream(log) {
  const id = String(log._id);
  const waitMs = Math.max(2000, Number(process.env.VOICE_STREAM_CONNECT_MS || 4000));
  setTimeout(async () => {
    try {
      const fresh = await CallLog.findById(id).select('callUuid finalizedAt context.streamStartedAt').lean();
      if (!fresh || fresh.finalizedAt || fresh.context?.streamStartedAt || !fresh.callUuid) return;
      logger.warn('[voice] live audio stream did not connect — switching this call to the classic engine. Check that your proxy allows WebSocket upgrades on /api/voice/stream.', { call: id });
      await plivo.transferCall(fresh.callUuid, hookUrl('classic', id));
    } catch (err) {
      logger.warn('[voice] could not switch the call to the classic engine', { call: id, error: plivo.errorText(err) });
    }
  }, waitMs).unref?.();
}

/* -------- fast replies: acknowledge at once, answer when ready -------- */

// Replies being prepared on this server: callId -> Promise<xml>.
const pendingReplies = new Map();
// If the reply isn't ready in this time, say a short "Ji…" / "Okay…" first
// so the customer never waits in silence, then deliver the reply.
const HOLD_AFTER_MS = Math.max(300, Number(process.env.VOICE_HOLD_AFTER_MS || 900));
const FILLERS = { hi: ['जी…', 'अच्छा…', 'जी, एक सेकंड…'], en: ['Okay…', 'Right…', 'Sure, one second…'], ar: ['حسنًا…'] };

function fillerFor(ctx, n = 0) {
  const list = FILLERS[ctx.language] || FILLERS.en;
  return list[n % list.length];
}

/** Pre-generates the short acknowledgement clips so they play instantly (cached). */
function warmFillers(ctx) {
  const list = FILLERS[ctx.language] || FILLERS.en;
  for (const text of list) speak(ctx, text, { timeoutMs: 8000 }).catch(() => {});
}

/** Customer said something → think → reply (with a quick acknowledgement if thinking is slow). */
async function onTurn(log, params) {
  const digit = String(params.Digits || '').trim();
  const dtmf = !params.Speech && Boolean(digit);
  const heard = String(params.Speech || digit || '').trim();
  if (!heard) return onNoInput(log);
  if (dtmf) return buildReply(log, { dtmf: true, digit, heard });

  const id = String(log._id);
  const job = buildReply(log, { dtmf: false, digit, heard })
    .catch((err) => {
      logger.error('[voice] reply failed', { call: id, error: err.message });
      return listen(log, { text: (log.context?.language === 'hi' ? 'माफ़ कीजिए, क्या आप फिर से बता सकते हैं?' : 'Sorry, could you say that again?') });
    });
  const quick = await Promise.race([job, new Promise((r) => { setTimeout(() => r(null), HOLD_AFTER_MS); })]);
  if (quick) return quick;
  // Slow path: keep the reply here and in the database (Plivo's next request
  // may reach another server).
  const held = job.then(async (xml) => {
    await CallLog.updateOne({ _id: log._id }, { $set: { 'context.pendingReplyXml': xml } }).catch(() => {});
    return xml;
  });
  pendingReplies.set(id, held);
  held.finally(() => setTimeout(() => pendingReplies.delete(id), 60000));
  const ctx = log.context || {};
  const ack = await speak(ctx, fillerFor(ctx, log.turns.length), { timeoutMs: 600 });
  return plivo.holdXml({ say: ack, language: ctx.language || 'hi', nextUrl: hookUrl('reply', log._id) });
}

/** Plivo fetches the reply after the acknowledgement. */
async function onReply(log) {
  const id = String(log._id);
  const local = pendingReplies.get(id);
  if (local) {
    pendingReplies.delete(id);
    await CallLog.updateOne({ _id: log._id }, { $unset: { 'context.pendingReplyXml': 1 } }).catch(() => {});
    return local;
  }
  // Prepared on another server: wait for it in the database (max ~8 s).
  const until = Date.now() + 8000;
  while (Date.now() < until) {
    const fresh = await CallLog.findById(log._id).select('context.pendingReplyXml').lean();
    const xml = fresh?.context?.pendingReplyXml;
    if (xml) {
      await CallLog.updateOne({ _id: log._id }, { $unset: { 'context.pendingReplyXml': 1 } }).catch(() => {});
      return xml;
    }
    await new Promise((r) => { setTimeout(r, 250); });
  }
  const ctx = log.context || {};
  return listen(log, await speak(ctx, ctx.language === 'hi' ? 'माफ़ कीजिए, क्या आप फिर से बता सकते हैं?' : 'Sorry, could you say that again?', { timeoutMs: 1500 }));
}

async function buildReply(log, { dtmf, digit, heard }) {
  log.turns.push({ role: 'customer', text: dtmf ? `[keypad ${digit}]` : heard.slice(0, 500) });
  log.noInputCount = 0;
  const ctx = log.context || {};
  const decision = dtmf ? dtmfDecision(ctx, digit) : await agent.nextTurn(ctx, log.turns);
  log.turns.push({ role: 'agent', text: decision.say });
  log.extracted = { ...(log.extracted || {}), ...pickOutcome(decision), model: decision.model };
  log.markModified('extracted');
  if (decision.summary) log.summary = decision.summary;
  if (decision.interested !== null && decision.interested !== undefined) log.interested = decision.interested;
  const say = await speak(ctx, decision.say);
  await log.save();

  // Decisive answer → apply it right away (does not wait for the hang-up callback).
  // (Lead calls are applied at the end, once the whole conversation is known.)
  if (isDecisive(decision) && ctx.purpose !== 'enquiry') await applyOutcomeSafe(log);
  emitCall(log);
  return decision.end_call ? goodbye(log, say) : listen(log, say);
}

/** Silence. Ask once more, then end politely. */
async function onNoInput(log) {
  const ctx = log.context || {};
  const hi = ctx.language === 'hi';
  log.noInputCount = (log.noInputCount || 0) + 1;
  if (log.noInputCount >= 2) {
    const text = hi ? 'लगता है आवाज़ नहीं आ रही। मैं आपको WhatsApp पर message कर रही हूँ। धन्यवाद!' : "I can't hear you, so I'll message you on WhatsApp. Thank you!";
    const fixed = platformVoice.agentGender() === 'male' ? text.replace('कर रही', 'कर रहा') : text;
    log.turns.push({ role: 'agent', text: fixed });
    await log.save();
    return goodbye(log, await speak(ctx, fixed));
  }
  const text = hi ? 'हेलो, क्या आप मुझे सुन पा रहे हैं?' : 'Hello, can you hear me?';
  log.turns.push({ role: 'agent', text });
  await log.save();
  return listen(log, await speak(ctx, text));
}

/** Call ended (answered or not) → final status, minutes, visit result, WhatsApp fallback. */
async function onHangup(log, params) {
  if (params.CallUUID && !log.callUuid) log.callUuid = params.CallUUID;
  // Live call: let the session save the transcript and read the result first.
  if (log.context?.engine === 'realtime') {
    await require('./realtime/session').finishCall(log._id).catch(() => {});
  } else if (log.context?.purpose === 'enquiry' && log.turns?.some((t) => t.role === 'customer')) {
    // Classic lead call: read the requirement (and any booking) from the whole conversation.
    try {
      const out = await agent.extractOutcome(log.context, log.turns);
      if (out) {
        const prev = log.extracted || {};
        const merged = { ...prev, lead: out.lead || prev.lead || null, rating: out.rating || prev.rating || null, rating_reason: out.rating_reason || prev.rating_reason || null };
        if (!prev.visit || prev.visit === 'unknown' || (prev.visit === 'confirmed' && !prev.new_date)) {
          Object.assign(merged, { visit: out.visit, new_date: out.new_date, new_time: out.new_time });
        }
        for (const k of ['follow_up_date', 'interested', 'callback_later']) if (merged[k] === undefined || merged[k] === null) merged[k] = out[k];
        await CallLog.updateOne({ _id: log._id }, { $set: { extracted: merged, ...(out.summary ? { summary: out.summary } : {}) } });
      }
    } catch (err) {
      logger.warn('[voice] could not read the lead call result', { call: String(log._id), error: err.message });
    }
  }
  const answered = Boolean(log.answeredAt || params.AnswerTime);
  let duration = Number(params.Duration || params.BillDuration || 0);
  if (!duration && answered) {
    const start = params.AnswerTime ? new Date(`${String(params.AnswerTime).replace(' ', 'T')}Z`) : log.answeredAt;
    const end = params.EndTime ? new Date(`${String(params.EndTime).replace(' ', 'T')}Z`) : new Date();
    const sec = Math.round((end - start) / 1000);
    duration = Number.isFinite(sec) && sec > 0 && sec < 3600 ? sec : Math.round((Date.now() - new Date(log.answeredAt || Date.now())) / 1000);
  }
  const raw = String(params.CallStatus || '').toLowerCase();
  let status;
  if (answered) status = 'completed';
  else if (raw === 'busy') status = 'busy';
  else if (raw === 'failed') status = 'failed';
  else if (raw === 'cancel' || raw === 'canceled' || raw === 'cancelled') status = 'canceled';
  else status = 'no-answer';
  return finalizeCall(log, { status, durationSec: duration, hangupCause: params.HangupCauseName || params.HangupCause || raw || null });
}

/**
 * Final bookkeeping for a call (idempotent). Also used for calls whose
 * hang-up callback never arrived (see visitConfirmation stale check).
 */
async function finalizeCall(log, { status, durationSec = 0, hangupCause = null } = {}) {
  const fresh = await CallLog.findOneAndUpdate({ _id: log._id, finalizedAt: null }, { $set: { finalizedAt: new Date() } }, { new: true });
  if (!fresh) return log; // already done
  log = fresh;
  log.status = status;
  log.endedAt = new Date();
  log.hangupCause = hangupCause;
  if (durationSec) log.durationSec = Math.max(0, Math.round(durationSec));
  if (status === 'completed' && !log.billedMinutes) {
    log.billedMinutes = Math.max(1, Math.ceil((log.durationSec || 1) / 60));
    const org = await orgService.getSnapshotForOwner(log.ownerId).catch(() => null);
    if (org && log.trigger !== 'test') {
      // Plan minutes first, then recharged packs; usage.voiceMinutes still grows by the full amount.
      await orgService.consumeVoiceMinutes(org._id, log.billedMinutes).catch((err) => logger.warn('[voice] minute billing failed', { call: String(log._id), error: err.message }));
      try { require('./voiceAlerts').afterBilling(org._id).catch(() => {}); } catch { /* alerts must never block billing */ }
    }
  }
  if (!log.outcome) {
    const e = log.extracted || {};
    log.outcome = status !== 'completed' ? null
      : e.visit === 'confirmed' ? 'confirmed'
      : e.visit === 'reschedule' ? 'reschedule'
      : e.follow_up_date ? 'follow_up'
      : e.callback_later ? 'callback_later'
      : e.interested === false ? 'not_interested'
      : e.visit === 'declined' ? 'declined'
      : 'unclear';
  }
  if (!log.summary && log.turns?.length) log.summary = log.turns.filter((t) => t.role === 'customer').map((t) => t.text).join(' / ').slice(0, 300);
  await log.save();
  logger.info('[voice] Call finished', { call: String(log._id), status, sec: log.durationSec, outcome: log.outcome });

  if (log.trigger === 'test' || !log.leadId) return log;
  // AI calling queue: mark the lead done / missed so the next one can be called.
  const answered = status === 'completed' && (log.durationSec || 0) > 5;
  const friendly = answered ? null : callPolicy.friendlyCallError({ status, hangupCause: log.hangupCause }) || log.hangupCause || status;
  await Lead.updateOne(
    { _id: log.leadId, 'aiCall.lastCallId': log._id, 'aiCall.status': 'calling' },
    { $set: { 'aiCall.status': answered ? 'done' : status === 'failed' ? 'failed' : 'missed', 'aiCall.error': friendly, 'aiCall.nextCallAt': null } },
  ).catch(() => {});
  if (friendly && !log.error) await CallLog.updateOne({ _id: log._id }, { $set: { error: friendly } }).catch(() => {});
  await orgService.runForOwner(log.ownerId, async () => {
    await applyOutcomeSafe(log);
    await noteOnLead(log);
    await afterLeadCall(log, { answered }).catch((err) => logger.warn('[voice] after-call follow-up failed', { call: String(log._id), error: err.message }));
    if (log.meetingId && log.purpose === 'visit_reminder') {
      // Reminder: the visit was already confirmed; only a reschedule changes it (handled above).
      await Meeting.updateOne({ _id: log.meetingId }, { $set: { 'confirmation.callStatus': status } }).catch(() => {});
    } else if (log.meetingId) {
      const meeting = await Meeting.findById(log.meetingId);
      if (meeting) {
        meeting.confirmation = meeting.confirmation || {};
        meeting.confirmation.callStatus = status;
        meeting.markModified('confirmation');
        await meeting.save();
        await require('../visits/visitConfirmation')
          .afterCallResult(meeting, { status, answered: status === 'completed', log })
          .catch((err) => logger.warn('[voice] after-call handling failed', { error: err.message }));
      }
    }
  });
  emitCall(log);
  return log;
}

/* ---------------- outcome → visit / follow-up / lead ---------------- */

function pickOutcome(d) {
  return {
    visit: d.visit,
    new_date: d.new_date || null,
    new_time: d.new_time || null,
    follow_up_date: d.follow_up_date || null,
    interested: d.interested ?? null,
    callback_later: Boolean(d.callback_later),
  };
}

function isDecisive(d) {
  return d.visit === 'confirmed' || (d.visit === 'reschedule' && d.new_date) || Boolean(d.follow_up_date) || (d.end_call && d.visit === 'declined');
}

async function applyOutcomeSafe(log) {
  try {
    await orgService.runForOwner(log.ownerId, () => applyOutcome(log));
  } catch (err) {
    logger.warn('[voice] could not apply call outcome', { call: String(log._id), error: err.message });
  }
}

/** Requirement the customer gave on the call → the lead (like the WhatsApp assistant does). */
async function saveLeadInfo(lead, info) {
  if (!info) return;
  const $set = {};
  if (info.budget_max_inr && !lead.budgetMax) $set.budgetMax = info.budget_max_inr;
  if (info.location && !lead.location) $set.location = info.location;
  if (info.project && !lead.project) $set.project = info.project;
  const parts = [
    info.requirement,
    info.looking_for && `Looking to ${info.looking_for}`,
    info.timeline && `Timeline: ${info.timeline}`,
  ].filter(Boolean);
  if (parts.length) {
    const line = `[AI call] ${parts.join(' · ')}`;
    if (!String(lead.requirements || '').includes(line)) $set.requirements = [lead.requirements, line].filter(Boolean).join('\n').slice(-2000);
  }
  if (Object.keys($set).length) await Lead.updateOne({ _id: lead._id }, { $set }).catch((err) => logger.warn('[voice] lead update failed', { error: err.message }));
}

const RATING_SCORE = { hot: 85, warm: 55, cold: 25, not_interested: 10 };

/** Lead call: how serious the customer is → lead rating (hot / warm / cold) and score. */
async function saveRating(lead, e, log) {
  if (log.purpose !== 'enquiry' || !RATING_SCORE[e.rating]) return;
  const $set = { 'aiCall.rating': e.rating };
  // A visit that is already booked / a deal that is closed or lost is never downgraded by a call.
  if (!['site_visit', 'closed', 'lost'].includes(lead.status)) {
    $set.status = e.rating === 'not_interested' ? 'cold' : e.rating;
    $set.leadScore = RATING_SCORE[e.rating];
  } else if (lead.status === 'site_visit') $set.leadScore = Math.max(lead.leadScore || 0, RATING_SCORE.hot);
  await Lead.updateOne({ _id: lead._id }, { $set }).catch((err) => logger.warn('[voice] rating save failed', { error: err.message }));
}

/** Writes what the customer decided on the call. Runs once per call. */
async function applyOutcome(log) {
  if (log.trigger === 'test' || !log.leadId) return;
  const e = log.extracted || {};
  // callback_later / interested alone must also count (e.g. keypad 2 = "call me later").
  if (!e.visit && !e.follow_up_date && !e.rating && !e.callback_later && typeof e.interested !== 'boolean') return;
  const claimed = await CallLog.findOneAndUpdate({ _id: log._id, outcomeAppliedAt: null }, { $set: { outcomeAppliedAt: new Date() } });
  if (!claimed) return;
  const lead = await Lead.findById(log.leadId);
  if (!lead) return;

  let meeting = log.meetingId ? await Meeting.findById(log.meetingId) : null;
  let outcome = null;
  await saveLeadInfo(lead, e.lead);
  await saveRating(lead, e, log);

  if (e.visit === 'confirmed' && meeting && !meeting.dateTentative) {
    const prevConf = meeting.confirmation?.toObject?.() || meeting.confirmation || {};
    // A reminder call keeps how the visit was confirmed originally.
    meeting.confirmation = { ...prevConf, status: 'confirmed', repliedAt: new Date(), confirmedVia: log.purpose === 'visit_reminder' && prevConf.confirmedVia ? prevConf.confirmedVia : 'call' };
    outcome = 'confirmed';
  } else if (!meeting && (e.visit === 'confirmed' || e.visit === 'reschedule') && e.new_date) {
    // Lead call booked a site visit → straight into Site visits, confirmed on the call.
    const time = e.new_time || '11:00';
    const conv = await Conversation.findOne({ leadId: lead._id }).select('_id').lean();
    const Property = require('../../models/Property');
    const projectName = e.lead?.project || lead.project || log.context?.project || '';
    const esc = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const property = projectName ? await Property.findOne({ projectName: new RegExp(`^${esc(projectName)}$`, 'i') }).select('_id').lean().catch(() => null) : null;
    const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
    const confirmation = { status: 'confirmed', repliedAt: new Date(), calledAt: new Date(), callLogId: log._id, callStatus: 'completed', confirmedVia: 'call' };
    // Already has an upcoming visit (e.g. booked in the WhatsApp chat)? Move that one instead of adding a second.
    const existing = await Meeting.findOne({ leadId: lead._id, status: { $in: ['scheduled', 'rescheduled'] }, preferredDate: { $gte: today } }).sort({ preferredDate: 1 });
    if (existing) {
      const changed = existing.preferredDate !== e.new_date || existing.preferredTime !== time;
      existing.preferredDate = e.new_date;
      existing.preferredTime = time;
      if (changed) existing.status = 'rescheduled';
      existing.dateTentative = false;
      if (!existing.propertyId && property?._id) existing.propertyId = property._id;
      existing.confirmation = { ...(existing.confirmation?.toObject?.() || existing.confirmation || {}), ...confirmation };
      meeting = existing;
    } else meeting = new Meeting({
      leadId: lead._id,
      ownerId: lead.ownerId,
      propertyId: property?._id || null,
      preferredDate: e.new_date,
      preferredTime: time,
      source: 'voice_ai',
      conversationId: conv?._id || null,
      notes: `Booked on AI call${projectName ? ` — ${projectName}` : ''}`,
      confirmation,
    });
    await meeting.save();
    log.meetingId = meeting._id;
    log.visitBooked = true;
    outcome = 'confirmed';
    await Lead.updateOne({ _id: lead._id, status: { $nin: ['closed', 'lost'] } }, { $set: { status: 'site_visit' } });
    await Conversation.updateOne({ leadId: lead._id }, { $set: { meetingStatus: 'scheduled' } }).catch(() => {});
    await FollowUp.updateMany({ leadId: lead._id, status: 'pending', generatedBy: 'voice_ai' }, { $set: { status: 'cancelled' } }).catch(() => {});
    // Same Google Calendar event the WhatsApp assistant creates (best effort).
    const { createCalendarEvent, updateCalendarEvent } = require('../calendar/googleCalendarService');
    if (meeting.googleEventId) updateCalendarEvent({ eventId: meeting.googleEventId, date: meeting.preferredDate, time: meeting.preferredTime }).catch(() => {});
    else createCalendarEvent({
      summary: `Site Visit — ${lead.name || lead.phone}${projectName ? ` (${projectName})` : ''}`,
      description: [`Lead: ${lead.name || 'N/A'} (${lead.phone})`, projectName && `Property: ${projectName}`, 'Booked automatically on an AI phone call.'].filter(Boolean).join('\n'),
      date: meeting.preferredDate,
      time: meeting.preferredTime,
    }).then((ev) => {
      if (ev?.eventId) return Meeting.updateOne({ _id: meeting._id }, { $set: { googleEventId: ev.eventId, googleEventLink: ev.eventLink || null } });
      return null;
    }).catch(() => {});
  } else if ((e.visit === 'reschedule' || (e.visit === 'confirmed' && meeting?.dateTentative)) && e.new_date) {
    const time = e.new_time || meeting?.preferredTime || '11:00';
    {
      const changed = meeting.preferredDate !== e.new_date || meeting.preferredTime !== time;
      meeting.preferredDate = e.new_date;
      meeting.preferredTime = time;
      if (changed && !meeting.dateTentative) meeting.status = 'rescheduled';
      meeting.dateTentative = false;
    }
    // New date agreed on the call → ask the customer to confirm it once more
    // on WhatsApp (YES / NO); their reply confirms the visit.
    meeting.confirmation = { ...(meeting.confirmation?.toObject?.() || meeting.confirmation || {}), status: 'pending', repliedAt: new Date(), confirmedVia: null, calledAt: meeting.confirmation?.calledAt || new Date() };
    outcome = 'reschedule';
    await Lead.updateOne({ _id: lead._id, status: { $nin: ['closed', 'lost'] } }, { $set: { status: 'site_visit' } });
    await Conversation.updateOne({ leadId: lead._id }, { $set: { meetingStatus: 'scheduled' } }).catch(() => {});
    if (meeting.googleEventId) {
      require('../calendar/googleCalendarService').updateCalendarEvent({ eventId: meeting.googleEventId, date: meeting.preferredDate, time: meeting.preferredTime }).catch(() => {});
    }
  } else if (!meeting && log.purpose === 'enquiry' && e.callback_later && e.interested !== false) {
    // Lead call: "busy hoon, baad mein call karo" → the AI calls again at that
    // time (next day when no time was given) + a short WhatsApp note now.
    const org = tenantContext.getOrg();
    const region = callPolicy.regionForPhone(lead.phone, org?.country);
    const at = e.follow_up_date ? new Date(`${e.follow_up_date}T${/^\d{2}:\d{2}$/.test(e.new_time || '') ? e.new_time : '11:00'}:00${region === 'AE' ? '+04:00' : '+05:30'}`) : null;
    const when = await postCall.scheduleRecall(lead, { at, delayMs: 24 * 3600 * 1000, reason: 'callback', orgCountry: org?.country });
    outcome = 'callback_later';
    const note = await postCall.confirmCallbackOnWhatsApp(lead, when, region);
    if (!note.sent && note.reason) await CallLog.updateOne({ _id: log._id }, { $set: { whatsappNote: note.reason } }).catch(() => {});
  } else if (e.visit === 'declined' || e.follow_up_date || e.interested === false) {
    if (meeting) {
      meeting.confirmation = { ...(meeting.confirmation?.toObject?.() || meeting.confirmation || {}), status: 'declined', repliedAt: new Date(), confirmedVia: 'call' };
      if (e.follow_up_date) {
        meeting.status = 'cancelled';
        meeting.notes = [meeting.notes, `On the call, the customer asked to talk on ${e.follow_up_date}.`].filter(Boolean).join('\n');
        await Conversation.updateOne({ leadId: lead._id }, { $set: { meetingStatus: 'cancelled' } }).catch(() => {});
      }
    }
    outcome = e.follow_up_date ? 'follow_up' : e.interested === false ? 'not_interested' : 'declined';
    if (e.follow_up_date) {
      await FollowUp.findOneAndUpdate(
        { leadId: lead._id, status: 'pending', kind: { $ne: 'sequence' } },
        {
          leadId: lead._id,
          ownerId: lead.ownerId,
          kind: 'ai',
          nextFollowUpDate: new Date(`${e.follow_up_date}T11:00:00+05:30`),
          nextFollowUpMessage: await followUpTextFor(lead, 'followup.afterCallDate'),
          urgency: 'medium',
          status: 'pending',
          generatedBy: 'voice_ai',
        },
        { upsert: true, new: true },
      ).catch((err) => logger.warn('[voice] follow-up save failed', { error: err.message }));
    }
    if (e.interested === false && lead.status === 'new') await Lead.updateOne({ _id: lead._id }, { $set: { status: 'cold' } });
  } else if (!meeting && (e.callback_later || e.interested === true)) {
    // Lead call: interested without a date → a follow-up for the team (the
    // WhatsApp bot also approaches the customer right away, see afterLeadCall).
    const days = e.callback_later ? 1 : 2;
    const at = new Date(`${new Date(Date.now() + 330 * 60000 + days * 86400000).toISOString().slice(0, 10)}T11:00:00+05:30`);
    outcome = e.callback_later ? 'callback_later' : 'follow_up';
    await FollowUp.findOneAndUpdate(
      { leadId: lead._id, status: 'pending', kind: { $ne: 'sequence' } },
      {
        leadId: lead._id,
        ownerId: lead.ownerId,
        kind: 'ai',
        nextFollowUpDate: at,
        nextFollowUpMessage: await followUpTextFor(lead, 'followup.afterCall'),
        urgency: e.interested ? 'high' : 'medium',
        status: 'pending',
        generatedBy: 'voice_ai',
      },
      { upsert: true, new: true },
    ).catch((err) => logger.warn('[voice] follow-up save failed', { error: err.message }));
  }

  if (meeting) {
    meeting.markModified('confirmation');
    await meeting.save();
  }
  if (outcome) {
    log.outcome = outcome;
    await CallLog.updateOne({ _id: log._id }, { $set: { outcome, meetingId: log.meetingId, visitBooked: log.visitBooked } });
    await Lead.updateOne({ _id: lead._id, 'aiCall.lastCallId': log._id }, { $set: { 'aiCall.outcome': outcome } }).catch(() => {});
    // A reminder call that only re-confirmed needs no extra WhatsApp message.
    if (!(log.purpose === 'visit_reminder' && outcome === 'confirmed')) {
      await require('../visits/visitConfirmation').afterCallOutcome(meeting, lead, outcome, e).catch((err) => logger.warn('[voice] post-outcome message failed', { error: err.message }));
    }
  }
}

/**
 * After a LEAD call (not visit confirmations):
 *   • call summary → WhatsApp chat context (bot won't ask again)
 *   • not picked up / busy / unreachable → one retry 2–3 h later; still not
 *     reached → the WhatsApp bot starts the conversation
 *   • interested but no visit fixed, or the call dropped mid-way → the
 *     WhatsApp bot approaches right away with the call summary
 * Never for STOP / opted-out leads, DND or wrong numbers.
 */
async function afterLeadCall(log, { answered }) {
  if (log.trigger === 'test' || !log.leadId || log.meetingId || log.purpose !== 'enquiry') return;
  const fresh = await CallLog.findById(log._id).select('outcome extracted summary turns durationSec visitBooked status hangupCause').lean();
  if (!fresh || fresh.visitBooked) {
    if (fresh?.summary) await postCall.rememberCall(await Lead.findById(log.leadId), fresh.summary);
    return;
  }
  const lead = await Lead.findById(log.leadId);
  if (!lead || (await callPolicy.isOptedOut(lead))) return;
  const org = tenantContext.getOrg();
  const region = callPolicy.regionForPhone(lead.phone, org?.country);
  const e = fresh.extracted || {};
  if (fresh.summary) await postCall.rememberCall(lead, fresh.summary);

  if (!answered) {
    const reason = callPolicy.friendlyCallError({ status: fresh.status, hangupCause: fresh.hangupCause }) || '';
    if (/wrong|invalid|dnd|stop|balance/i.test(reason)) return; // retrying would not help
    if ((lead.aiCall?.retries || 0) < 1) {
      const delay = (2 + Math.random()) * 3600 * 1000; // 2–3 hours
      await postCall.scheduleRecall(lead, { delayMs: delay, reason: 'retry', orgCountry: org?.country });
      return;
    }
    const sent = await postCall.notReachedOnWhatsApp(lead, region);
    await Lead.updateOne({ _id: lead._id }, { $set: { 'aiCall.retries': 0 } }).catch(() => {});
    if (!sent.sent && sent.reason) await CallLog.updateOne({ _id: log._id }, { $set: { whatsappNote: sent.reason } }).catch(() => {});
    return;
  }
  await Lead.updateOne({ _id: lead._id }, { $set: { 'aiCall.retries': 0 } }).catch(() => {});
  if (fresh.outcome === 'callback_later' || e.interested === false || e.follow_up_date) return; // handled in applyOutcome
  const spoke = (fresh.turns || []).some((t) => t.role === 'customer');
  const interested = e.interested === true || ['hot', 'warm'].includes(e.rating);
  const dropped = spoke && (!fresh.outcome || fresh.outcome === 'unclear') && e.interested !== false;
  if (interested || dropped) {
    const sent = await postCall.approachOnWhatsApp(lead, { summary: fresh.summary || '', region, reason: interested ? 'interested' : 'dropped' });
    if (!sent.sent && sent.reason) await CallLog.updateOne({ _id: log._id }, { $set: { whatsappNote: sent.reason } }).catch(() => {});
  }
}

async function noteOnLead(log) {
  if (log.status !== 'completed') return;
  const lead = await Lead.findById(log.leadId);
  if (!lead) return;
  const rate = log.extracted?.rating ? ` · ${String(log.extracted.rating).replace('_', ' ').toUpperCase()}` : '';
  const line = `[AI call ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}] ${log.durationSec}s${rate}${log.summary ? ` — ${log.summary}` : ''}`;
  lead.notes = [lead.notes, line].filter(Boolean).join('\n').slice(-5000);
  if (log.interested === true && (lead.leadScore || 0) < 45 && !log.extracted?.rating) lead.leadScore = 45;
  await lead.save();
  if (!log.meetingId || log.visitBooked) {
    await Notification.create({
      userId: lead.ownerId,
      type: 'ai_call',
      title: `AI call: ${lead.name}${log.visitBooked ? ' — visit booked' : log.interested ? ' — interested' : ''}`,
      body: log.summary ? log.summary.slice(0, 280) : `${log.durationSec}s call`,
      link: `/whatsapp/conversations?lead=${lead._id}`,
    }).catch(() => {});
  }
}

function emitCall(log) {
  try {
    require('../../sockets').emitToUser(log.ownerId, 'call:updated', { callId: String(log._id), status: log.status, meetingId: log.meetingId ? String(log.meetingId) : null });
  } catch { /* sockets not ready */ }
}

/* -------- Auto-call new leads that haven't replied on WhatsApp -------- */
async function autoCallTick() {
  if (!platformVoice.isConfigured()) return;
  // Calling hours are checked per customer region (India / UAE) below.
  const orgs = await Organization.find({ 'voice.enabled': true, 'voice.autoCallNewLeads': true, status: { $in: ['active', 'past_due'] } }).select('_id ownerUserId voice plan status featureOverrides country limitOverrides usage voicePrepaidUsed addonGrants').lean();
  const { hasFeature, voiceMinutesExhausted } = require('../saas/subscription');
  for (const o of orgs) {
    if (!hasFeature(o, 'aiCalling')) continue; // free trial / plans without AI calling
    // Minutes finished: skip the company. Its leads are NOT marked failed, so they are called after a recharge.
    if (voiceMinutesExhausted(o) || o.voice?.paused) continue;
    let minutesFinished = false;
    const after = (o.voice.autoCallAfterMinutes || 30) * 60000;
    const leads = await Lead.find({
      ownerId: o.ownerUserId,
      phone: { $ne: null },
      createdAt: { $gte: new Date(Date.now() - 6 * 3600000), $lte: new Date(Date.now() - after) },
      source: { $nin: ['csv_import', 'manual', 'whatsapp_inbound'] }, // only fresh enquiries (forms, ads, portals, CPs)
      optedOut: { $ne: true },
      'aiCall.status': { $nin: ['failed', 'queued', 'calling', 'cancelled'] },
    }).limit(50).lean();
    for (const lead of leads) {
      if (await CallLog.exists({ leadId: lead._id })) continue;
      if (await Message.exists({ leadId: lead._id, direction: 'inbound' })) continue;
      await orgService.runForOrg(o._id, async () => {
        // Outside this customer's calling hours (or region switched off) → try again on a later tick.
        const settings = await require('../settings/settingsService').getOrCreateSettings();
        const region = callPolicy.regionForPhone(lead.phone, o.country);
        if (!callPolicy.regionEnabled(region) || !callPolicy.inHours(region, settings)) return;
        try {
          await placeCall(lead, { trigger: 'auto_new_lead' });
        } catch (err) {
          if (CALL_BLOCKED.includes(err.details?.code)) {
            minutesFinished = true; // leave the lead as it is; calls resume after a recharge / when switched on again
            return;
          }
          // STOP / DND / wrong number etc. → don't retry every minute; the reason shows in AI calling.
          await Lead.updateOne({ _id: lead._id }, { $set: { 'aiCall.status': 'failed', 'aiCall.error': String(err.message || 'Call failed').slice(0, 200) } }).catch(() => {});
          logger.warn('[voice] auto call failed', { lead: String(lead._id), error: err.message });
        }
      }).catch((err) => logger.warn('[voice] auto call failed', { lead: String(lead._id), error: err.message }));
      if (minutesFinished) {
        logger.info('[voice] auto-calling paused: AI calling minutes finished', { org: String(o._id) });
        break; // no more leads for this company this tick
      }
    }
  }
}

/* -------- AI calling queue (AI calling → Leads → "Call selected") -------- */
// Calls running at the same time per company (Plivo account limits apply). Default 1, max 10.
const BULK_CONCURRENCY = Math.min(Math.max(Number(process.env.VOICE_BULK_CONCURRENCY) || 1, 1), 10);
// Contacts that can be added to the AI calling queue in one go.
const BULK_BATCH_MAX = 100;
const CALL_STUCK_MS = 20 * 60 * 1000;


/** Calls queued leads, one (or VOICE_BULK_CONCURRENCY) at a time per company, in calling hours. */
async function bulkCallTick() {
  if (!platformVoice.isConfigured()) return;
  // Calls that never reported back: free the slot.
  await Lead.updateMany(
    { 'aiCall.status': 'calling', 'aiCall.lastCallAt': { $lt: new Date(Date.now() - CALL_STUCK_MS) } },
    { $set: { 'aiCall.status': 'missed', 'aiCall.error': 'No result from the phone network' } },
  ).catch(() => {});
  const owners = await Lead.distinct('ownerId', { 'aiCall.status': 'queued' });
  const { hasFeature, subscriptionState, voiceMinutesExhausted } = require('../saas/subscription');
  for (const ownerId of owners) {
    await orgService.runForOwner(ownerId, async () => {
      const org = tenantContext.getOrg();
      if (org && (!hasFeature(org, 'aiCalling') || !subscriptionState(org).active)) return;
      // Minutes finished, or all AI calling switched off: leave every queued lead queued
      // (they resume automatically after a recharge / when it is switched back on).
      const live = org ? await orgService.withFreshVoice(org) : null;
      if (live && (voiceMinutesExhausted(live) || live.voice?.paused)) return;
      const settings = await require('../settings/settingsService').getOrCreateSettings().catch(() => null);
      // UAE numbers while UAE calling is switched off → clear reason instead of waiting forever.
      if (!callPolicy.regionEnabled('AE')) {
        await Lead.updateMany(
          { ownerId, 'aiCall.status': 'queued', phone: /^\+?971/ },
          { $set: { 'aiCall.status': 'failed', 'aiCall.error': 'AI calling for UAE numbers is switched off' } },
        ).catch(() => {});
      }
      const indiaOpen = callPolicy.inHours('IN', settings);
      const uaeOpen = callPolicy.regionEnabled('AE') && callPolicy.inHours('AE', settings);
      if (!indiaOpen && !uaeOpen) return;
      const regionFilter = indiaOpen && uaeOpen ? {} : indiaOpen ? { phone: { $not: /^\+?971/ } } : { phone: /^\+?971/ };
      const busy = await Lead.countDocuments({ ownerId, 'aiCall.status': 'calling' });
      for (let i = busy; i < BULK_CONCURRENCY; i += 1) {
        const lead = await Lead.findOneAndUpdate(
          {
            ownerId,
            'aiCall.status': 'queued',
            ...regionFilter,
            // Call-backs / retries wait for their time.
            $or: [{ 'aiCall.nextCallAt': null }, { 'aiCall.nextCallAt': { $lte: new Date() } }],
          },
          { $set: { 'aiCall.status': 'calling', 'aiCall.lastCallAt': new Date(), 'aiCall.error': null, 'aiCall.nextCallAt': null }, $inc: { 'aiCall.calls': 1 } },
          { sort: { 'aiCall.queuedAt': 1 }, new: true },
        );
        if (!lead) break;
        const optedOut = lead.optedOut || (await Conversation.exists({ leadId: lead._id, optedOut: true }));
        if (optedOut || !lead.phone) {
          await Lead.updateOne({ _id: lead._id }, { $set: { 'aiCall.status': 'failed', 'aiCall.error': optedOut ? 'Customer opted out (STOP)' : 'No phone number' } });
          continue;
        }
        try {
          const log = await placeCall(lead, { trigger: 'bulk' });
          await Lead.updateOne({ _id: lead._id }, { $set: { 'aiCall.lastCallId': log._id } });
        } catch (err) {
          if (CALL_BLOCKED.includes(err.details?.code)) {
            // Minutes ran out / calling was switched off between the check and the call: put the lead back in the queue, untouched.
            await Lead.updateOne({ _id: lead._id }, { $set: { 'aiCall.status': 'queued' }, $inc: { 'aiCall.calls': -1 } }).catch(() => {});
            logger.info('[voice] queue paused: AI calling minutes finished', { ownerId: String(ownerId) });
            break;
          }
          await Lead.updateOne({ _id: lead._id }, { $set: { 'aiCall.status': 'failed', 'aiCall.error': String(err.message || 'Call failed').slice(0, 200) } });
          logger.warn('[voice] queued call failed', { lead: String(lead._id), error: err.message });
        }
      }
    }).catch((err) => logger.warn('[voice] queue tick failed for company', { ownerId: String(ownerId), error: err.message }));
  }
}

/**
 * Visit-day reminder: on the day of a confirmed visit, call the customer
 * (in calling hours, at least an hour before the visit) — "your visit today
 * is confirmed, we hope to see you". Once per visit.
 */
async function reminderCallTick() {
  if (!platformVoice.isConfigured()) return;
  const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  const Settings = require('../../models/Settings');
  const companies = await Settings.find({ 'visitConfirm.callEnabled': { $ne: false }, 'visitConfirm.reminderCall': { $ne: false }, orgId: { $ne: null } }).select('orgId visitConfirm').lean();
  const { hasFeature, subscriptionState } = require('../saas/subscription');
  for (const s of companies) {
    await orgService.runForOrg(s.orgId, async () => {
      const org = tenantContext.getOrg();
      if (!org || !hasFeature(org, 'aiCalling') || !subscriptionState(org).active) return;
      if (org.voice?.paused) return; // client switched all AI calling off
      const cfg = s.visitConfirm || {};
      const h = new Date(Date.now() + 330 * 60000).getUTCHours();
      if (h < (Number.isFinite(cfg.callStartHour) ? cfg.callStartHour : 10) || h >= (Number.isFinite(cfg.callEndHour) ? cfg.callEndHour : 19)) return;
      const due = await Meeting.find({
        ownerId: org.ownerUserId,
        preferredDate: today,
        status: { $in: ['scheduled', 'rescheduled'] },
        dateTentative: { $ne: true },
        'confirmation.status': 'confirmed',
        'confirmation.reminderCallAt': null,
      }).populate('propertyId', 'projectName builderName location city bhk propertyType budgetMin budgetMax possession amenities').limit(20);
      for (const meeting of due) {
        const at = new Date(`${meeting.preferredDate}T${meeting.preferredTime || '11:00'}:00+05:30`);
        if (Number.isNaN(at.getTime()) || at.getTime() - Date.now() < 60 * 60 * 1000) continue; // too close / past
        // A call confirmed it in the last 3 hours? No need to call again.
        if (meeting.confirmation?.repliedAt && Date.now() - new Date(meeting.confirmation.repliedAt).getTime() < 3 * 3600 * 1000) continue;
        const claimed = await Meeting.updateOne({ _id: meeting._id, 'confirmation.reminderCallAt': null }, { $set: { 'confirmation.reminderCallAt': new Date() } });
        if (!claimed.modifiedCount) continue;
        const lead = await Lead.findById(meeting.leadId);
        if (!lead?.phone || lead.optedOut) continue;
        try {
          const log = await placeCall(lead, { trigger: 'visit_reminder', meeting, reminder: true });
          await Meeting.updateOne({ _id: meeting._id }, { $set: { 'confirmation.reminderCallLogId': log._id } });
        } catch (err) {
          if (CALL_BLOCKED.includes(err.details?.code)) {
            // No calling minutes left (or calling switched off meanwhile): the customer still gets the visit-day reminder on WhatsApp.
            await require('../visits/visitConfirmation').afterCallOutcome(meeting, lead, 'confirmed').catch(() => {});
            logger.info('[voice] visit-day reminder sent on WhatsApp (AI calling minutes finished)', { meeting: String(meeting._id) });
            continue;
          }
          if (err.details?.code === 'CALL_LANGUAGE_UNSUPPORTED') {
            // E5: the customer's language can't be spoken on calls → remind on WhatsApp in their language.
            await require('../visits/visitConfirmation').afterCallOutcome(meeting, lead, 'confirmed').catch(() => {});
            logger.info('[voice] visit-day reminder sent on WhatsApp (call language not available)', { meeting: String(meeting._id), language: err.details.language });
            continue;
          }
          logger.warn('[voice] reminder call failed', { meeting: String(meeting._id), error: err.message });
        }
      }
    }).catch((err) => logger.warn('[voice] reminder tick failed', { error: err.message }));
  }
}

let handle = null;
let queueHandle = null;
function startAutoCallScheduler() {
  if (handle) return;
  const { withLock } = require('../../utils/distributedLock');
  handle = setInterval(() => withLock('voice-autocall', 110 * 1000, autoCallTick).catch((err) => logger.error('[voice] tick failed', { error: err.message })), 2 * 60 * 1000);
  // Lead calling queue (every minute) + visit-day reminders (every 5 minutes).
  queueHandle = setInterval(() => withLock('voice-queue', 55 * 1000, bulkCallTick).catch((err) => logger.error('[voice] queue tick failed', { error: err.message })), 60 * 1000);
  setInterval(() => withLock('voice-reminders', 4 * 60 * 1000, reminderCallTick).catch((err) => logger.error('[voice] reminder tick failed', { error: err.message })), 5 * 60 * 1000);
  const missing = platformVoice.missing();
  if (missing.length) logger.warn(`[voice] AI calling is OFF until these env vars are set: ${missing.join(', ')}`);
  else logger.info(`[voice] AI calling ready (Plivo${platformVoice.elevenLabs('hi') ? ' + ElevenLabs' : ', Plivo voice'})`);
}

module.exports = {
  placeCall,
  callTimeLimit,
  testCall,
  voiceConfig,
  autoCallTick,
  bulkCallTick,
  reminderCallTick,
  startAutoCallScheduler,
  onAnswer,
  onFallback,
  onTurn,
  onReply,
  onNoInput,
  onHangup,
  finalizeCall,
  applyOutcome,
  afterLeadCall,
  e164,
  BULK_BATCH_MAX,
};
