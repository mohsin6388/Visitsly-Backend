/**
 * Site visit confirmation.
 *
 * Two flows (Settings → visitConfirm.mode):
 *
 *  call_first (default, needs AI calling set up)
 *    Visit booked → after `callDelayMinutes` (inside calling hours) the AI
 *    calls the buyer to confirm. If the call is not answered / fails / gives
 *    no clear answer, a WhatsApp message goes out: "Humne call kiya tha,
 *    baat nahi ho paayi — kya aap aa rahe hain? YES / NO". The buyer's reply
 *    confirms the visit and it shows up on the Site visits page.
 *
 *  whatsapp_first
 *    `hoursBefore` the visit a WhatsApp "kya aap aa rahe hain?" goes out; if no
 *    reply in `callAfterHours`, the AI calls.
 *
 * When AI calling is not set up, call_first silently behaves like whatsapp_first.
 */
const Settings = require("../../models/Settings");
const Meeting = require("../../models/Meeting");
const Lead = require("../../models/Lead");
const Conversation = require("../../models/Conversation");
const Notification = require("../../models/Notification");
const CallLog = require("../../models/CallLog");
const Organization = require("../../models/Organization");
const metaWhatsappClient = require("../whatsapp/metaWhatsappClient");
const { recordOutboundMessage } = require("../whatsapp/messageStore");
const settingsService = require("../settings/settingsService");
const orgService = require("../saas/orgService");
const tenantContext = require("../../context/tenantContext");
const { withLock } = require("../../utils/distributedLock");
const logger = require("../../utils/logger");

const TZ_OFFSET = "+05:30";
const TICK_MS = 5 * 60 * 1000;
const JUST_BOOKED_MS = 3 * 60 * 60 * 1000; // whatsapp_first: don't ask right after booking
const CALL_FAIL = ["no-answer", "busy", "failed", "canceled", "cancelled", "error", "call-disconnected", "stopped"];
const CALL_STALE_MS = 30 * 60 * 1000; // no result from the voice provider in 30 min = treat as not answered

const YES_RE = /^\s*(yes|yep|yup|y|haan|han|haa|ha|hanji|haan ji|ji haan|ok|okay|k|confirm|confirmed|done|sure|pakka|theek hai|thik hai|aa raha|aa rahi|aa rahe|aaunga|aaungi|aunga|aayenge|aenge|zaroor|bilkul|1)\b|^\s*(👍|✅|👌)/i;
const NO_RE = /^\s*(no|nope|n|nahi|nahin|nhi|na|cancel|cancelled|nahi aa|nahi aa paunga|nahi aa sakte|can'?t|cannot|reschedule|postpone|2)\b|\b(reschedule|postpone|cancel|nahi aa paunga|nahi aa paungi|nahi aa payenge)\b/i;

function visitDate(meeting) {
  const d = new Date(`${meeting.preferredDate}T${meeting.preferredTime}:00${TZ_OFFSET}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function istDay(offsetDays = 0) {
  return new Date(Date.now() + 330 * 60000 + offsetDays * 86400000).toISOString().slice(0, 10);
}

function istHour() {
  return new Date(Date.now() + 330 * 60000).getUTCHours();
}

function labels(meeting) {
  const date = meeting.preferredDate;
  const dateLabel = date === istDay(0) ? "aaj" : date === istDay(1) ? "kal" : new Date(`${date}T00:00:00${TZ_OFFSET}`).toLocaleDateString("en-IN", { day: "numeric", month: "short", weekday: "short" });
  const [h, m] = String(meeting.preferredTime).split(":").map(Number);
  const timeLabel = `${(h % 12) || 12}:${String(m || 0).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
  return { dateLabel, timeLabel };
}

function buildText(lead, meeting, project, { afterMissedCall = false } = {}) {
  const { dateLabel, timeLabel } = labels(meeting);
  const first = String(lead.name || "").trim().split(/\s+/)[0] || "";
  const hello = `Namaste${first && !/^whatsapp$/i.test(first) ? ` ${first}` : ""}!`;
  const intro = afterMissedCall
    ? `${hello} Humne aapki site visit confirm karne ke liye call kiya tha, lekin baat nahi ho paayi 🙏\n\n`
    : `${hello} `;
  return (
    `${intro}Aapki site visit${project ? ` (${project})` : ""} ${dateLabel} ${timeLabel} baje scheduled hai.\n\n` +
    `Kya aap aa rahe hain? Confirm karne ke liye *YES* reply karein. Time badalna ho to *NO* likhein.`
  );
}

async function voiceReady(orgId) {
  if (!orgId) return false;
  const org = await Organization.findById(orgId).select("+voice.apiKeyEncrypted voice status").lean();
  return Boolean(org?.voice?.enabled && org.voice.apiKeyEncrypted && org.voice.agentId);
}

/** Sends the WhatsApp confirmation (tenant context required). */
async function sendConfirmation(meetingId, { force = false, afterMissedCall = false } = {}) {
  const meeting = await Meeting.findById(meetingId).populate("propertyId", "projectName");
  if (!meeting) throw new Error("Site visit nahi mili");
  if (!["scheduled", "rescheduled"].includes(meeting.status)) throw new Error("Sirf scheduled visit ke liye confirmation bhej sakte hain");
  const current = meeting.confirmation?.status;
  if (!force && !afterMissedCall && current && current !== "none") return { skipped: true };
  if (["confirmed", "declined"].includes(current) && !force) return { skipped: true };

  const lead = await Lead.findById(meeting.leadId);
  if (!lead?.phone) throw new Error("Lead ka WhatsApp number nahi hai");
  const conversation = await Conversation.findOne({ leadId: lead._id });
  if (conversation?.optedOut) throw new Error("Customer ne messages band karwaye hain (STOP)");
  const settings = await settingsService.getOrCreateSettings();
  const cfg = settings.visitConfirm || {};
  const project = meeting.propertyId?.projectName || "";

  const lastInbound = conversation?.lastInboundAt ? new Date(conversation.lastInboundAt).getTime() : 0;
  const windowOpen = Date.now() - lastInbound < 24 * 60 * 60 * 1000;

  let sentId = null;
  let shownText = buildText(lead, meeting, project, { afterMissedCall });
  const prev = meeting.confirmation?.toObject?.() || meeting.confirmation || {};
  try {
    if (windowOpen) {
      ({ messageId: sentId } = await metaWhatsappClient.sendTextMessage({ phone: lead.phone, text: shownText }));
    } else if (cfg.templateName) {
      const { dateLabel, timeLabel } = labels(meeting);
      const values = [String(lead.name || "").trim().split(/\s+/)[0] || "Customer", project || "our project", dateLabel, timeLabel];
      const count = Math.min(Math.max(Number(cfg.templateVariableCount) || 0, 0), values.length);
      const components = count ? [{ type: "body", parameters: values.slice(0, count).map((text) => ({ type: "text", text })) }] : [];
      ({ messageId: sentId } = await metaWhatsappClient.sendTemplateMessage({
        phone: lead.phone,
        templateName: cfg.templateName,
        languageCode: cfg.templateLanguage || "en_US",
        components,
      }));
      shownText = `[Visit confirmation template: ${cfg.templateName}] ${shownText}`;
    } else {
      throw new Error("Customer ne 24 ghante se message nahi kiya, isliye seedha WhatsApp nahi ja sakta. Visit confirmation page par ek approved template chunein.");
    }
  } catch (err) {
    meeting.confirmation = { ...prev, status: prev.status || "none", error: String(err.metaError?.message || err.message).slice(0, 300), lastAttemptAt: new Date() };
    meeting.markModified("confirmation");
    await meeting.save();
    throw err;
  }

  if (conversation) {
    await recordOutboundMessage({ conversationId: conversation._id, leadId: lead._id, text: shownText, sender: "ai", whatsappMessageId: sentId, ownerId: conversation.ownerId }).catch(() => {});
  }
  meeting.confirmation = {
    ...prev,
    status: "pending",
    sentAt: new Date(),
    repliedAt: null,
    error: null,
    lastAttemptAt: new Date(),
    ...(afterMissedCall ? { whatsappFallbackAt: new Date() } : {}),
  };
  meeting.markModified("confirmation");
  await meeting.save();
  return { sent: true };
}

async function notifyOwner(ownerId, lead, meeting, kind, via) {
  const { dateLabel, timeLabel } = labels(meeting);
  await Notification.create({
    userId: ownerId,
    type: kind === "confirmed" ? "site_visit_confirmed" : "site_visit_declined",
    title: kind === "confirmed" ? `${lead.name || "Lead"} ne visit confirm ki${via === "call" ? " (call par)" : ""}` : `${lead.name || "Lead"} visit nahi kar paayenge`,
    body: `${dateLabel} ${timeLabel}${kind === "declined" ? " — time badalne ke liye unse baat karein." : ""}`,
    link: "/site-visits",
  }).catch(() => {});
  try {
    const settings = await settingsService.getOrCreateSettings();
    if (settings.alertOn?.visitConfirmed === false) return;
    const { sendOwnerAlert } = require("../alerts/ownerAlerts");
    await sendOwnerAlert({
      kind: kind === "confirmed" ? "visit_confirmed" : "visit_declined",
      title: kind === "confirmed" ? `✅ VISIT CONFIRMED — ${lead.name || "Buyer"}` : `⚠️ VISIT NAHI HOGI — ${lead.name || "Buyer"}`,
      lines: [`📞 ${lead.phone || "-"}`, `🗓 ${meeting.preferredDate} · ${meeting.preferredTime}`, via === "call" ? "AI call par jawab mila." : "WhatsApp par jawab mila.", kind === "declined" ? "Naya time fix karne ke liye customer ko call karein." : ""],
      link: "/site-visits",
      templateValues: [lead.name || "Lead", lead.phone || "-", `${meeting.preferredDate} ${meeting.preferredTime}`, kind === "confirmed" ? "Visit confirmed" : "Visit declined", via || "-"],
    });
  } catch (err) {
    logger.warn("[visit-confirm] owner alert failed", { error: err.message });
  }
}

/**
 * Inbound WhatsApp reply check. Returns true when we answered this message
 * ourselves (so the AI must not reply again). Tenant context required.
 */
async function handleReply({ lead, conversation, text }) {
  const body = String(text || "").trim();
  if (!body || body.length > 60) return false; // long message = normal chat, AI handles it

  const meeting = await Meeting.findOne({
    leadId: lead._id,
    status: { $in: ["scheduled", "rescheduled"] },
    "confirmation.status": "pending",
    preferredDate: { $gte: istDay(-1) },
  }).sort({ preferredDate: 1, preferredTime: 1 });
  if (!meeting) return false;

  const isNo = NO_RE.test(body);
  const isYes = !isNo && YES_RE.test(body);
  if (!isYes && !isNo) return false;

  meeting.confirmation.status = isYes ? "confirmed" : "declined";
  meeting.confirmation.repliedAt = new Date();
  meeting.confirmation.confirmedVia = "whatsapp";
  meeting.markModified("confirmation");
  await meeting.save();
  emitMeeting(meeting);

  const { dateLabel, timeLabel } = labels(meeting);
  const reply = isYes
    ? `Dhanyavaad! Aapki visit ${dateLabel} ${timeLabel} baje ke liye confirm ho gayi hai. Hum aapka intezaar karenge 🙏`
    : "Theek hai, koi baat nahi. Aap kis din aur kitne baje aa sakte hain? Hum visit usi hisaab se reschedule kar denge.";
  try {
    const { messageId } = await metaWhatsappClient.sendTextMessage({ phone: lead.phone, text: reply });
    await recordOutboundMessage({ conversationId: conversation._id, leadId: lead._id, text: reply, sender: "ai", whatsappMessageId: messageId, ownerId: conversation.ownerId });
  } catch (err) {
    logger.warn("[visit-confirm] Ack message failed", { error: err.message });
  }
  await notifyOwner(meeting.ownerId, lead, meeting, isYes ? "confirmed" : "declined", "whatsapp");
  return true;
}

function emitMeeting(meeting) {
  try {
    require("../../sockets").emitToUser(meeting.ownerId, "meeting:updated", { meetingId: String(meeting._id), confirmation: meeting.confirmation, status: meeting.status });
  } catch { /* socket not initialised */ }
}

/** Places the AI confirmation call (tenant context required). */
async function callConfirmation(meetingId, { publicBase } = {}) {
  const meeting = await Meeting.findById(meetingId).populate("propertyId", "projectName");
  if (!meeting) throw new Error("Site visit nahi mili");
  if (!["scheduled", "rescheduled"].includes(meeting.status)) throw new Error("Sirf scheduled visit ke liye call laga sakte hain");
  const lead = await Lead.findById(meeting.leadId);
  if (!lead?.phone) throw new Error("Lead ka phone number nahi hai");
  const prev = meeting.confirmation?.toObject?.() || meeting.confirmation || {};
  try {
    const log = await require("../voice/voiceService").placeCall(lead, { trigger: "visit_confirmation", meeting, publicBase });
    meeting.confirmation = {
      ...prev,
      status: prev.status && prev.status !== "none" ? prev.status : "pending",
      calledAt: new Date(),
      callStatus: log.status || "queued",
      callAttempts: (prev.callAttempts || 0) + 1,
      callLogId: log._id,
      lastAttemptAt: new Date(),
      error: null,
    };
    meeting.markModified("confirmation");
    await meeting.save();
    emitMeeting(meeting);
    return log;
  } catch (err) {
    meeting.confirmation = { ...prev, calledAt: new Date(), callStatus: "failed", callAttempts: (prev.callAttempts || 0) + 1, error: String(err.message).slice(0, 300), lastAttemptAt: new Date() };
    meeting.markModified("confirmation");
    await meeting.save();
    throw err;
  }
}

/**
 * Called by the voice webhook once a confirmation call ends (tenant context).
 * Not answered / failed / unclear → WhatsApp fallback right away.
 */
async function afterCallResult(meeting, { status, answered }) {
  emitMeeting(meeting);
  const s = String(status || "").toLowerCase();
  const final = s === "completed" || CALL_FAIL.includes(s);
  if (!final) return;
  if (["confirmed", "declined"].includes(meeting.confirmation?.status)) {
    const lead = await Lead.findById(meeting.leadId).select("name phone");
    if (lead && meeting.confirmation.confirmedVia === "call") await notifyOwner(meeting.ownerId, lead, meeting, meeting.confirmation.status, "call");
    return;
  }
  if (meeting.confirmation?.whatsappFallbackAt) return; // already sent
  const settings = await settingsService.getOrCreateSettings();
  const retries = Number(settings.visitConfirm?.callRetries) || 0;
  if (!answered && (meeting.confirmation?.callAttempts || 0) <= retries) return; // the tick will retry the call first
  try {
    await sendConfirmation(meeting._id, { afterMissedCall: true, force: true });
    logger.info("[visit-confirm] Call not confirmed → WhatsApp fallback sent", { meeting: String(meeting._id), status: s });
  } catch (err) {
    logger.warn("[visit-confirm] WhatsApp fallback failed", { meeting: String(meeting._id), error: err.message });
  }
}

function inCallingHours(cfg) {
  const h = istHour();
  const start = Number.isFinite(cfg.callStartHour) ? cfg.callStartHour : 10;
  const end = Number.isFinite(cfg.callEndHour) ? cfg.callEndHour : 19;
  return h >= start && h < end;
}

async function runCallFirst(cfg, horizonDays) {
  if (!inCallingHours(cfg)) return;
  const delayMs = (Number.isFinite(cfg.callDelayMinutes) ? cfg.callDelayMinutes : 30) * 60000;
  const retries = Number(cfg.callRetries) || 0;

  // 1) New visits → first call
  const fresh = await Meeting.find({
    status: { $in: ["scheduled", "rescheduled"] },
    "confirmation.calledAt": null,
    "confirmation.status": { $nin: ["confirmed", "declined"] },
    preferredDate: { $gte: istDay(0), $lte: istDay(horizonDays) },
    createdAt: { $lte: new Date(Date.now() - delayMs) },
  }).limit(40);
  for (const meeting of fresh) {
    const at = visitDate(meeting);
    if (!at || at.getTime() - Date.now() < 45 * 60 * 1000) continue;
    try {
      await Meeting.updateOne({ _id: meeting._id }, { $set: { "confirmation.flow": "call_first" } });
      await callConfirmation(meeting._id);
    } catch (err) {
      logger.warn("[visit-confirm] call-first call failed, using WhatsApp", { meeting: String(meeting._id), error: err.message });
      await sendConfirmation(meeting._id, { afterMissedCall: true, force: true }).catch((e) => logger.warn("[visit-confirm] fallback failed", { error: e.message }));
    }
  }

  // 2) Unanswered calls → retry (if configured) or WhatsApp fallback.
  //    Also catches calls whose result never arrived (stale).
  const pendingCalls = await Meeting.find({
    status: { $in: ["scheduled", "rescheduled"] },
    "confirmation.calledAt": { $ne: null },
    "confirmation.whatsappFallbackAt": null,
    "confirmation.status": { $nin: ["confirmed", "declined"] },
    preferredDate: { $gte: istDay(0), $lte: istDay(horizonDays) },
  }).limit(60);
  for (const meeting of pendingCalls) {
    const c = meeting.confirmation || {};
    const st = String(c.callStatus || "").toLowerCase();
    const stale = !CALL_FAIL.includes(st) && st !== "completed" && Date.now() - new Date(c.calledAt).getTime() > CALL_STALE_MS;
    const failed = CALL_FAIL.includes(st) || stale || st === "completed";
    if (!failed) continue;
    const at = visitDate(meeting);
    if (!at || at.getTime() < Date.now()) continue;
    try {
      if (!stale && st !== "completed" && (c.callAttempts || 0) <= retries && Date.now() - new Date(c.calledAt).getTime() > 60 * 60 * 1000) {
        await callConfirmation(meeting._id);
      } else {
        await sendConfirmation(meeting._id, { afterMissedCall: true, force: true });
      }
    } catch (err) {
      logger.warn("[visit-confirm] retry/fallback failed", { meeting: String(meeting._id), error: err.message });
    }
  }
}

async function runWhatsappFirst(cfg, s) {
  const hours = Math.min(Math.max(Number(cfg.hoursBefore) || 24, 1), 72);
  const horizon = Date.now() + hours * 3600 * 1000;
  const candidates = await Meeting.find({
    status: { $in: ["scheduled", "rescheduled"] },
    $or: [{ "confirmation.status": "none" }, { "confirmation.status": { $exists: false } }],
    preferredDate: { $gte: istDay(0), $lte: istDay(Math.ceil(hours / 24) + 1) },
  }).limit(200);
  for (const meeting of candidates) {
    const at = visitDate(meeting);
    if (!at || at.getTime() <= Date.now() || at.getTime() > horizon) continue;
    if (Date.now() - new Date(meeting.createdAt).getTime() < JUST_BOOKED_MS) continue;
    const last = meeting.confirmation?.lastAttemptAt ? new Date(meeting.confirmation.lastAttemptAt).getTime() : 0;
    if (Date.now() - last < 60 * 60 * 1000) continue;
    try {
      await Meeting.updateOne({ _id: meeting._id }, { $set: { "confirmation.flow": "whatsapp_first" } });
      await sendConfirmation(meeting._id);
    } catch (err) {
      logger.warn("[visit-confirm] Could not send", { meeting: String(meeting._id), error: err.message });
    }
  }

  // No reply → AI call
  if (cfg.callEnabled && (await voiceReady(s.orgId)) && inCallingHours(cfg)) {
    const waitMs = (Number(cfg.callAfterHours) || 3) * 3600 * 1000;
    const toCall = await Meeting.find({
      status: { $in: ["scheduled", "rescheduled"] },
      "confirmation.calledAt": null,
      preferredDate: { $gte: istDay(0), $lte: istDay(Math.ceil(hours / 24) + 1) },
      $or: [
        { "confirmation.status": "pending", "confirmation.sentAt": { $lte: new Date(Date.now() - waitMs) } },
        { "confirmation.status": "none", "confirmation.error": { $ne: null }, "confirmation.lastAttemptAt": { $lte: new Date(Date.now() - 3600 * 1000) } },
      ],
    }).limit(50);
    for (const meeting of toCall) {
      const at = visitDate(meeting);
      if (!at || at.getTime() - Date.now() < 45 * 60 * 1000 || at.getTime() > horizon) continue;
      try {
        await callConfirmation(meeting._id);
      } catch (err) {
        logger.warn("[visit-confirm] AI call failed", { meeting: String(meeting._id), error: err.message });
      }
    }
  }
}

/** Scheduler: every company with confirmation turned on. */
async function tick() {
  const companies = await Settings.find({ $or: [{ "visitConfirm.enabled": true }, { "visitConfirm.callEnabled": true }] }).select("orgId visitConfirm").lean();
  for (const s of companies) {
    const cfg = s.visitConfirm || {};
    const run = async () => {
      const callFirst = (cfg.mode || "call_first") === "call_first" && cfg.callEnabled && (await voiceReady(s.orgId));
      if (callFirst) await runCallFirst(cfg, 7);
      else if (cfg.enabled) await runWhatsappFirst(cfg, s);
      else if (cfg.callEnabled) await runWhatsappFirst({ ...cfg, enabled: false }, s);
    };
    try {
      if (s.orgId) await orgService.runForOrg(s.orgId, run);
      else await run();
    } catch (err) {
      logger.error("[visit-confirm] Company tick failed", { error: err.message });
    }
  }
}

/** Numbers for the Visit confirmation page. */
async function stats({ days = 30 } = {}) {
  const ownerId = tenantContext.ownerId();
  const since = istDay(-days);
  const match = { preferredDate: { $gte: since }, ...(ownerId ? { ownerId } : {}) };
  const [visits, calls] = await Promise.all([
    Meeting.find(match).select("confirmation status preferredDate").lean(),
    CallLog.find({ trigger: "visit_confirmation", createdAt: { $gte: new Date(Date.now() - days * 86400000) }, ...(ownerId ? { ownerId } : {}) }).select("status durationSec").lean(),
  ]);
  const out = {
    days,
    visits: visits.length,
    upcoming: visits.filter((v) => v.preferredDate >= istDay(0) && ["scheduled", "rescheduled"].includes(v.status)).length,
    callsPlaced: calls.length,
    callsAnswered: calls.filter((c) => String(c.status).toLowerCase() === "completed" && (c.durationSec || 0) > 5).length,
    callsNotAnswered: calls.filter((c) => CALL_FAIL.includes(String(c.status).toLowerCase())).length,
    callsInProgress: calls.filter((c) => !CALL_FAIL.includes(String(c.status).toLowerCase()) && String(c.status).toLowerCase() !== "completed").length,
    whatsappSent: visits.filter((v) => v.confirmation?.sentAt).length,
    whatsappFallbacks: visits.filter((v) => v.confirmation?.whatsappFallbackAt).length,
    confirmed: visits.filter((v) => v.confirmation?.status === "confirmed").length,
    confirmedByCall: visits.filter((v) => v.confirmation?.status === "confirmed" && v.confirmation?.confirmedVia === "call").length,
    confirmedByWhatsapp: visits.filter((v) => v.confirmation?.status === "confirmed" && v.confirmation?.confirmedVia !== "call").length,
    declined: visits.filter((v) => v.confirmation?.status === "declined").length,
    waiting: visits.filter((v) => v.confirmation?.status === "pending").length,
  };
  return out;
}

let handle = null;
function startVisitConfirmationScheduler() {
  if (handle) return;
  const run = () => withLock("visit-confirmation", TICK_MS - 10000, tick).catch((err) => logger.error("[visit-confirm] tick failed", { error: err.message }));
  handle = setInterval(run, TICK_MS);
  setTimeout(run, 30000).unref?.();
  logger.info("[visit-confirm] Scheduler started (every 5 min)");
}

module.exports = { sendConfirmation, callConfirmation, afterCallResult, handleReply, startVisitConfirmationScheduler, tick, stats, YES_RE, NO_RE, CALL_FAIL };
