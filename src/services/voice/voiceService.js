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
const ApiError = require('../../utils/ApiError');
const tenantContext = require('../../context/tenantContext');
const orgService = require('../saas/orgService');
const logger = require('../../utils/logger');

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
async function voiceConfig(orgId, { language = null } = {}) {
  const org = await Organization.findById(orgId).select('name country').lean();
  const v = platformVoice.resolve({ country: org?.country || 'IN', language });
  return { ...(v || {}), available: Boolean(v), companyName: org?.name || '', country: org?.country || 'IN' };
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

/** Generates the clip for a sentence (null → Plivo voice fallback). */
async function speak(ctx, text, { timeoutMs = Number(process.env.ELEVENLABS_LIVE_TIMEOUT_MS || 4000) } = {}) {
  const cfg = platformVoice.elevenLabs(ctx.language);
  const id = cfg ? await tts.synthesize(cfg, text, ctx.language, { timeoutMs }) : null;
  return { audioUrl: audioUrl(id), text };
}

/* ---------------- placing calls ---------------- */

/**
 * Places an AI call to a lead. Must run inside the company's tenant context.
 * meeting → visit-confirmation call; otherwise an enquiry call.
 */
async function placeCall(lead, { trigger = 'manual', requestedBy = null, meeting = null } = {}) {
  const org = tenantContext.getOrg();
  if (!org) throw new Error('placeCall needs a tenant context');
  const { subscriptionState } = require('../saas/subscription');
  if (!subscriptionState(org).active) throw ApiError.forbidden('Subscription is not active');
  const missing = platformVoice.missing();
  if (missing.length) throw ApiError.badRequest(`AI calling is not set up (${missing.join(', ')} missing).`);

  const conv = await Conversation.findOne({ leadId: lead._id }).select('language').lean();
  const cfg = await voiceConfig(org._id, { language: conv?.language });
  if (!cfg.available) throw ApiError.badRequest('AI calling is not available yet. Please contact support.');
  const to = e164(lead.phone);
  if (!to) throw ApiError.badRequest('Lead has no phone number');

  let property = null;
  if (meeting?.propertyId) {
    property = meeting.propertyId?.projectName ? meeting.propertyId : await require('../../models/Property').findById(meeting.propertyId).lean();
  }
  const project = property?.projectName || lead.project || '';
  const purpose = meeting ? 'visit_confirmation' : 'enquiry';
  const tentative = Boolean(meeting?.dateTentative);
  const ctx = {
    purpose,
    orgId: String(org._id),
    name: lead.name || '',
    company: cfg.companyName,
    project,
    requirement: lead.requirements || '',
    visitDate: meeting?.preferredDate || null,
    visitTime: meeting?.preferredTime || null,
    visitDay: meeting ? platformVoice.spokenDate(meeting.preferredDate, 'en') : null,
    tentative,
    language: cfg.language,
    sttLanguage: cfg.sttLanguage,
    facts: facts(property),
  };
  const opening = meeting
    ? platformVoice.confirmationScript(cfg.language, { name: lead.name, project, date: meeting.preferredDate, time: meeting.preferredTime, company: cfg.companyName, tentative })
    : platformVoice.enquiryScript(cfg.language, { name: lead.name, project, company: cfg.companyName });

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

  // Pre-generate the opening line so the customer hears it the moment they pick up.
  const first = await speak(ctx, opening, { timeoutMs: 9000 });
  log.context = { ...log.context, openingAudioUrl: first.audioUrl };
  log.markModified('context');

  try {
    const { requestUuid } = await plivo.makeCall({
      from: cfg.fromNumber,
      to,
      answerUrl: hookUrl('answer', log._id),
      hangupUrl: hookUrl('hangup', log._id),
    });
    log.executionId = requestUuid;
    log.status = 'queued';
    await log.save();
    logger.info('[voice] Call placed', { call: String(log._id), purpose, to });
    return log;
  } catch (err) {
    log.status = 'failed';
    log.error = plivo.errorText(err);
    log.finalizedAt = new Date();
    await log.save();
    logger.warn('[voice] Plivo call failed', { call: String(log._id), error: log.error });
    throw ApiError.badRequest(`Call failed: ${log.error}`);
  }
}

/** Visit-confirmation page → "Test call": calls the owner's own number with a sample visit. */
async function testCall(phone) {
  const org = tenantContext.getOrg();
  if (!org) throw new Error('testCall needs a tenant context');
  const missing = platformVoice.missing();
  if (missing.length) throw ApiError.badRequest(`AI calling is not set up (${missing.join(', ')} missing).`);
  const cfg = await voiceConfig(org._id);
  if (!cfg.available) throw ApiError.badRequest('AI calling is not available yet. Please contact support.');
  const to = e164(phone);
  if (!to) throw ApiError.badRequest('Enter a valid mobile number');
  const tomorrow = new Date(Date.now() + 330 * 60000 + 86400000).toISOString().slice(0, 10);
  const ctx = {
    purpose: 'visit_confirmation', orgId: String(org._id), name: 'Test', company: cfg.companyName, project: 'Sample Project',
    visitDate: tomorrow, visitTime: '11:00', visitDay: platformVoice.spokenDate(tomorrow, 'en'), tentative: false,
    language: cfg.language, sttLanguage: cfg.sttLanguage, facts: 'Project: Sample Project (test call)',
  };
  const opening = platformVoice.confirmationScript(cfg.language, { name: '', project: 'Sample Project', date: tomorrow, time: '11:00', company: cfg.companyName });
  const log = await CallLog.create({ ownerId: org.ownerUserId, leadId: null, trigger: 'test', purpose: 'test', language: cfg.language, toNumber: to, fromNumber: cfg.fromNumber, context: { ...ctx, opening } });
  const first = await speak(ctx, opening, { timeoutMs: 9000 });
  log.context = { ...log.context, openingAudioUrl: first.audioUrl };
  log.markModified('context');
  try {
    const { requestUuid } = await plivo.makeCall({ from: cfg.fromNumber, to, answerUrl: hookUrl('answer', log._id), hangupUrl: hookUrl('hangup', log._id) });
    log.executionId = requestUuid;
    await log.save();
    return { callId: String(log._id), status: 'queued', language: cfg.language, voice: first.audioUrl ? 'elevenlabs' : 'plivo' };
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

function listen(log, say) {
  const ctx = log.context || {};
  return plivo.gatherXml({
    actionUrl: hookUrl('turn', log._id),
    noInputUrl: hookUrl('noinput', log._id),
    say,
    sttLanguage: ctx.sttLanguage || 'hi-IN',
    language: ctx.language || 'hi',
  });
}

function goodbye(log, say) {
  return plivo.hangupXml({ say, language: log.context?.language || 'hi' });
}

/** Call picked up → opening line, then listen. */
async function onAnswer(log, params) {
  if (!log.answeredAt) log.answeredAt = new Date();
  if (params.CallUUID) log.callUuid = params.CallUUID;
  log.status = 'in-progress';
  const ctx = log.context || {};
  const say = ctx.openingAudioUrl ? { audioUrl: ctx.openingAudioUrl, text: ctx.opening } : await speak(ctx, ctx.opening);
  if (!log.turns.length) log.turns.push({ role: 'agent', text: ctx.opening });
  await log.save();
  emitCall(log);
  return listen(log, say);
}

/** Customer said something → think → reply. */
async function onTurn(log, params) {
  const heard = String(params.Speech || params.Digits || '').trim();
  if (!heard) return onNoInput(log);
  log.turns.push({ role: 'customer', text: heard.slice(0, 500) });
  log.noInputCount = 0;
  const ctx = log.context || {};
  const decision = await agent.nextTurn(ctx, log.turns);
  log.turns.push({ role: 'agent', text: decision.say });
  log.extracted = { ...(log.extracted || {}), ...pickOutcome(decision), model: decision.model };
  log.markModified('extracted');
  if (decision.summary) log.summary = decision.summary;
  if (decision.interested !== null && decision.interested !== undefined) log.interested = decision.interested;
  const say = await speak(ctx, decision.say);
  await log.save();

  // Decisive answer → apply it right away (does not wait for the hang-up callback).
  if (isDecisive(decision)) await applyOutcomeSafe(log);
  emitCall(log);
  return decision.end_call ? goodbye(log, say) : listen(log, say);
}

/** Silence. Ask once more, then end politely. */
async function onNoInput(log) {
  const ctx = log.context || {};
  const hi = ctx.language !== 'en' && ctx.language !== 'ar';
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
    if (org && log.trigger !== 'test') await orgService.incrementUsage(org._id, 'voiceMinutes', log.billedMinutes).catch(() => {});
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
  await orgService.runForOwner(log.ownerId, async () => {
    await applyOutcomeSafe(log);
    await noteOnLead(log);
    if (log.meetingId) {
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

/** Writes what the customer decided on the call. Runs once per call. */
async function applyOutcome(log) {
  if (log.trigger === 'test' || !log.leadId) return;
  const e = log.extracted || {};
  if (!e.visit && !e.follow_up_date) return;
  const claimed = await CallLog.findOneAndUpdate({ _id: log._id, outcomeAppliedAt: null }, { $set: { outcomeAppliedAt: new Date() } });
  if (!claimed) return;
  const lead = await Lead.findById(log.leadId);
  if (!lead) return;

  let meeting = log.meetingId ? await Meeting.findById(log.meetingId) : null;
  let outcome = null;

  if (e.visit === 'confirmed' && meeting && !meeting.dateTentative) {
    meeting.confirmation = { ...(meeting.confirmation?.toObject?.() || meeting.confirmation || {}), status: 'confirmed', repliedAt: new Date(), confirmedVia: 'call' };
    outcome = 'confirmed';
  } else if ((e.visit === 'reschedule' || (e.visit === 'confirmed' && meeting?.dateTentative)) && e.new_date) {
    const time = e.new_time || meeting?.preferredTime || '11:00';
    if (!meeting) {
      // Enquiry call booked a visit.
      const conv = await Conversation.findOne({ leadId: lead._id }).select('_id').lean();
      meeting = await Meeting.create({ leadId: lead._id, ownerId: lead.ownerId, preferredDate: e.new_date, preferredTime: time, source: 'voice_ai', conversationId: conv?._id || null, notes: 'Booked on AI call' });
      log.meetingId = meeting._id;
      log.visitBooked = true;
    } else {
      const changed = meeting.preferredDate !== e.new_date || meeting.preferredTime !== time;
      meeting.preferredDate = e.new_date;
      meeting.preferredTime = time;
      if (changed && !meeting.dateTentative) meeting.status = 'rescheduled';
      meeting.dateTentative = false;
    }
    meeting.confirmation = { ...(meeting.confirmation?.toObject?.() || meeting.confirmation || {}), status: 'confirmed', repliedAt: new Date(), confirmedVia: 'call', calledAt: meeting.confirmation?.calledAt || new Date() };
    outcome = 'reschedule';
    await Lead.updateOne({ _id: lead._id, status: { $nin: ['closed', 'lost'] } }, { $set: { status: 'site_visit' } });
    await Conversation.updateOne({ leadId: lead._id }, { $set: { meetingStatus: 'scheduled' } }).catch(() => {});
    if (meeting.googleEventId) {
      require('../calendar/googleCalendarService').updateCalendarEvent({ eventId: meeting.googleEventId, date: meeting.preferredDate, time: meeting.preferredTime }).catch(() => {});
    }
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
          nextFollowUpMessage: `Hi ${String(lead.name || '').split(' ')[0] || ''}! You asked us to reach out around now — shall we plan your site visit? Which day works for you?`.replace('Namaste !', 'Namaste!'),
          urgency: 'medium',
          status: 'pending',
          generatedBy: 'voice_ai',
        },
        { upsert: true, new: true },
      ).catch((err) => logger.warn('[voice] follow-up save failed', { error: err.message }));
    }
    if (e.interested === false && lead.status === 'new') await Lead.updateOne({ _id: lead._id }, { $set: { status: 'cold' } });
  }

  if (meeting) {
    meeting.markModified('confirmation');
    await meeting.save();
  }
  if (outcome) {
    log.outcome = outcome;
    await CallLog.updateOne({ _id: log._id }, { $set: { outcome, meetingId: log.meetingId, visitBooked: log.visitBooked } });
    await require('../visits/visitConfirmation').afterCallOutcome(meeting, lead, outcome, e).catch((err) => logger.warn('[voice] post-outcome message failed', { error: err.message }));
  }
}

async function noteOnLead(log) {
  if (log.status !== 'completed') return;
  const lead = await Lead.findById(log.leadId);
  if (!lead) return;
  const line = `[AI call ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}] ${log.durationSec}s${log.summary ? ` — ${log.summary}` : ''}`;
  lead.notes = [lead.notes, line].filter(Boolean).join('\n').slice(-5000);
  if (log.interested === true && (lead.leadScore || 0) < 45) lead.leadScore = 45;
  await lead.save();
  if (!log.meetingId || log.visitBooked) {
    await Notification.create({
      userId: lead.ownerId,
      type: 'ai_call',
      title: `AI call: ${lead.name}${log.visitBooked ? ' — visit book!' : log.interested ? ' — interested' : ''}`,
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
  const hourIST = new Date(Date.now() + 330 * 60000).getUTCHours();
  if (hourIST < 10 || hourIST >= 19) return; // polite calling hours
  const orgs = await Organization.find({ 'voice.enabled': true, 'voice.autoCallNewLeads': true, status: { $in: ['trialing', 'active', 'past_due'] } }).select('_id ownerUserId voice').lean();
  for (const o of orgs) {
    const after = (o.voice.autoCallAfterMinutes || 30) * 60000;
    const leads = await Lead.find({
      ownerId: o.ownerUserId,
      phone: { $ne: null },
      createdAt: { $gte: new Date(Date.now() - 6 * 3600000), $lte: new Date(Date.now() - after) },
      source: { $nin: ['csv_import', 'manual', 'whatsapp_inbound'] }, // only fresh enquiries (forms, ads, portals, CPs)
    }).limit(50).lean();
    for (const lead of leads) {
      if (await CallLog.exists({ leadId: lead._id })) continue;
      if (await Message.exists({ leadId: lead._id, direction: 'inbound' })) continue;
      await orgService.runForOrg(o._id, () => placeCall(lead, { trigger: 'auto_new_lead' })).catch((err) => logger.warn('[voice] auto call failed', { lead: String(lead._id), error: err.message }));
    }
  }
}

let handle = null;
function startAutoCallScheduler() {
  if (handle) return;
  const { withLock } = require('../../utils/distributedLock');
  handle = setInterval(() => withLock('voice-autocall', 110 * 1000, autoCallTick).catch((err) => logger.error('[voice] tick failed', { error: err.message })), 2 * 60 * 1000);
  const missing = platformVoice.missing();
  if (missing.length) logger.warn(`[voice] AI calling is OFF until these env vars are set: ${missing.join(', ')}`);
  else logger.info(`[voice] AI calling ready (Plivo${platformVoice.elevenLabs('hi') ? ' + ElevenLabs' : ', Plivo voice'})`);
}

module.exports = {
  placeCall,
  testCall,
  voiceConfig,
  autoCallTick,
  startAutoCallScheduler,
  onAnswer,
  onTurn,
  onNoInput,
  onHangup,
  finalizeCall,
  applyOutcome,
  e164,
};
