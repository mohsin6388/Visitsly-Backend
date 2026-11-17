/**
 * Site visit confirmation (one simple flow).
 *
 *  AI calling ON (default — the client's main toggle on the Visit confirmation page)
 *    Customer says "yes" to a site visit in the WhatsApp chat → the visit is
 *    booked → within ~1 minute (inside calling hours) the AI calls the buyer
 *    (Plivo + ElevenLabs voice): "your visit to <project> on <date/time> — will you come?".
 *      yes            → visit confirmed (owner alerted, WhatsApp note to the buyer)
 *      new day/time   → visit moved + confirmed
 *      no             → AI asks for another day or when to follow up
 *    Call not answered / failed / unclear → WhatsApp right away:
 *      "Humne call kiya tha… kya aap aa rahe hain?"  [Haan, confirm ✅] [Nahi / date badlo]
 *      Haan → confirmed.  Nahi → bot asks for a new date or a follow-up time.
 *
 *  AI calling OFF
 *    No calls. Only WhatsApp "kya aap aa rahe hain? YES / NO" `hoursBefore` the visit.
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
const platformVoice = require("../../config/voiceAgents");
const logger = require("../../utils/logger");

const TZ_OFFSET = "+05:30";
const TICK_MS = 2 * 60 * 1000;
const JUST_BOOKED_MS = 3 * 60 * 60 * 1000; // whatsapp_first: don't ask right after booking
const CALL_FAIL = ["no-answer", "busy", "failed", "canceled", "cancelled", "error", "call-disconnected", "stopped"];
const CALL_STALE_MS = 8 * 60 * 1000; // no hang-up result 8 min after dialing (call limit is 5 min) = treat as finished

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

function isEnglish(conversation) {
  return /^en|english/i.test(String(conversation?.language || ""));
}

function buildText(lead, meeting, project, { afterMissedCall = false, english = false } = {}) {
  const { dateLabel, timeLabel } = labels(meeting);
  const first = String(lead.name || "").trim().split(/\s+/)[0] || "";
  const name = first && !/^whatsapp$/i.test(first) ? ` ${first}` : "";
  if (english) {
    const intro = afterMissedCall ? `Hello${name}! We called you to confirm your site visit but couldn't reach you 🙏\n\n` : `Hello${name}! `;
    if (meeting.dateTentative) return `${intro}Which day and time would suit you for the site visit${project ? ` to ${project}` : ""}? Just reply here.`;
    return `${intro}Your site visit${project ? ` (${project})` : ""} is scheduled for ${dateLabel === "aaj" ? "today" : dateLabel === "kal" ? "tomorrow" : dateLabel} at ${timeLabel}.\n\nWill you be coming? Please confirm with *YES*, or reply *NO* to change the date.`;
  }
  const intro = afterMissedCall
    ? `Namaste${name}! Humne aapki site visit confirm karne ke liye call kiya tha, lekin call uth nahi paayi 🙏\n\n`
    : `Namaste${name}! `;
  if (meeting.dateTentative) return `${intro}Aap site visit${project ? ` (${project})` : ""} ke liye kis din aur kitne baje aana chahenge? Yahin reply kar dijiye.`;
  return (
    `${intro}Aapki site visit${project ? ` (${project})` : ""} ${dateLabel} ${timeLabel} baje scheduled hai.\n\n` +
    `Kya aap aa rahe hain? Confirm karne ke liye *YES* reply karein. Date/time badalna ho to *NO* likhein.`
  );
}

const BUTTONS = {
  hi: [{ id: "visit_yes", title: "Haan, confirm ✅" }, { id: "visit_no", title: "Nahi / date badlo" }],
  en: [{ id: "visit_yes", title: "Yes, I'll come ✅" }, { id: "visit_no", title: "No, change date" }],
};

/** Platform voice (Plivo + ElevenLabs) is configured by us, not by the client. */
async function voiceReady() {
  return platformVoice.isConfigured();
}

/** Sends the WhatsApp confirmation (tenant context required). */
async function sendConfirmation(meetingId, { force = false, afterMissedCall = false } = {}) {
  const meeting = await Meeting.findById(meetingId).populate("propertyId", "projectName");
  if (!meeting) throw new Error("Site visit not found");
  if (!["scheduled", "rescheduled"].includes(meeting.status)) throw new Error("Confirmation can only be sent for scheduled visits");
  const current = meeting.confirmation?.status;
  if (!force && !afterMissedCall && current && current !== "none") return { skipped: true };
  if (["confirmed", "declined"].includes(current) && !force) return { skipped: true };

  const lead = await Lead.findById(meeting.leadId);
  if (!lead?.phone) throw new Error("Lead has no WhatsApp number");
  const conversation = await Conversation.findOne({ leadId: lead._id });
  if (conversation?.optedOut) throw new Error("Customer opted out (STOP)");
  const settings = await settingsService.getOrCreateSettings();
  const cfg = settings.visitConfirm || {};
  const project = meeting.propertyId?.projectName || "";

  const lastInbound = conversation?.lastInboundAt ? new Date(conversation.lastInboundAt).getTime() : 0;
  const windowOpen = Date.now() - lastInbound < 24 * 60 * 60 * 1000;

  let sentId = null;
  const english = isEnglish(conversation);
  let shownText = buildText(lead, meeting, project, { afterMissedCall, english });
  const prev = meeting.confirmation?.toObject?.() || meeting.confirmation || {};
  try {
    if (windowOpen) {
      ({ messageId: sentId } = meeting.dateTentative
        ? await metaWhatsappClient.sendTextMessage({ phone: lead.phone, text: shownText })
        : await metaWhatsappClient.sendButtonsMessage({ phone: lead.phone, text: shownText, buttons: english ? BUTTONS.en : BUTTONS.hi }));
    } else if (cfg.templateName && !meeting.dateTentative) {
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
      throw new Error("Customer has not messaged in 24 hours, so a direct WhatsApp is not allowed. Choose an approved template in AI calling → Settings.");
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
    title: kind === "confirmed" ? `${lead.name || "Lead"} ne visit confirm ki${via === "call" ? " (call par)" : ""}` : `${lead.name || "Lead"} can’t make the visit`,
    body: `${dateLabel} ${timeLabel}${kind === "declined" ? " — contact them to reschedule." : ""}`,
    link: "/site-visits",
  }).catch(() => {});
  try {
    const settings = await settingsService.getOrCreateSettings();
    if (settings.alertOn?.visitConfirmed === false) return;
    const { sendOwnerAlert } = require("../alerts/ownerAlerts");
    await sendOwnerAlert({
      kind: kind === "confirmed" ? "visit_confirmed" : "visit_declined",
      title: kind === "confirmed" ? `✅ VISIT CONFIRMED — ${lead.name || "Buyer"}` : `⚠️ VISIT CANCELLED — ${lead.name || "Buyer"}`,
      lines: [`📞 ${lead.phone || "-"}`, `🗓 ${meeting.preferredDate} · ${meeting.preferredTime}`, via === "call" ? "AI call par jawab mila." : "WhatsApp par jawab mila.", kind === "declined" ? "Call the customer to set a new time." : ""],
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
  if (!meeting || meeting.dateTentative) return false; // a date is being collected → the AI chat handles it

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
  const english = isEnglish(conversation);
  const reply = isYes
    ? english
      ? `Thank you! Your visit is confirmed for ${dateLabel === "aaj" ? "today" : dateLabel === "kal" ? "tomorrow" : dateLabel} at ${timeLabel}. See you there 🙏`
      : `Dhanyavaad! Aapki visit ${dateLabel} ${timeLabel} baje ke liye confirm ho gayi hai. Hum aapka intezaar karenge 🙏`
    : english
      ? "No problem 🙏 Which other day and time would suit you for the visit? If you're not sure yet, just tell me when we should get back to you."
      : "Koi baat nahi 🙏 Aap kis din aur kitne baje aa sakte hain? Agar abhi pakka nahi hai to bata dijiye — hum aapse kab dobara baat karein?";
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
async function callConfirmation(meetingId) {
  const meeting = await Meeting.findById(meetingId).populate("propertyId", "projectName builderName location city bhk propertyType budgetMin budgetMax possession amenities");
  if (!meeting) throw new Error("Site visit not found");
  if (!["scheduled", "rescheduled"].includes(meeting.status)) throw new Error("Calls can only be placed for scheduled visits");
  const lead = await Lead.findById(meeting.leadId);
  if (!lead?.phone) throw new Error("Lead has no phone number");
  const conversation = await Conversation.findOne({ leadId: lead._id }).select("optedOut").lean();
  if (conversation?.optedOut) throw new Error("Customer opted out (STOP)");
  const prev = meeting.confirmation?.toObject?.() || meeting.confirmation || {};
  try {
    const log = await require("../voice/voiceService").placeCall(lead, { trigger: "visit_confirmation", meeting });
    await Meeting.updateOne(
      { _id: meeting._id },
      {
        $set: {
          "confirmation.status": prev.status && prev.status !== "none" ? prev.status : "pending",
          "confirmation.calledAt": new Date(),
          "confirmation.callStatus": log.status || "queued",
          "confirmation.callAttempts": (prev.callAttempts || 0) + 1,
          "confirmation.callLogId": log._id,
          "confirmation.lastAttemptAt": new Date(),
          "confirmation.error": null,
        },
      },
    );
    emitMeeting(await Meeting.findById(meeting._id).lean());
    return log;
  } catch (err) {
    await Meeting.updateOne(
      { _id: meeting._id },
      {
        $set: {
          "confirmation.calledAt": new Date(),
          "confirmation.callStatus": "failed",
          "confirmation.callAttempts": (prev.callAttempts || 0) + 1,
          "confirmation.error": String(err.message).slice(0, 300),
          "confirmation.lastAttemptAt": new Date(),
        },
      },
    );
    throw err;
  }
}

/**
 * First confirmation call for a visit — claimed atomically so the instant
 * trigger and the scheduler (or two servers) never call the customer twice.
 * Not reachable → WhatsApp fallback straight away. Tenant context required.
 */
async function firstCall(meetingId) {
  const meeting = await Meeting.findById(meetingId).select("status preferredDate preferredTime confirmation dateTentative").lean();
  if (!meeting || !["scheduled", "rescheduled"].includes(meeting.status)) return { skipped: "not_scheduled" };
  const at = visitDate(meeting);
  if (!meeting.dateTentative && (!at || at.getTime() - Date.now() < 45 * 60 * 1000)) return { skipped: "too_close" };
  const claimed = await Meeting.findOneAndUpdate(
    {
      _id: meetingId,
      status: { $in: ["scheduled", "rescheduled"] },
      "confirmation.calledAt": null,
      "confirmation.status": { $nin: ["confirmed", "declined"] },
    },
    { $set: { "confirmation.calledAt": new Date(), "confirmation.flow": "call_first" } },
    { new: true },
  );
  if (!claimed) return { skipped: "already_called" };
  try {
    const log = await callConfirmation(meetingId);
    return { called: true, callId: String(log._id) };
  } catch (err) {
    logger.warn("[visit-confirm] call could not be placed → WhatsApp", { meeting: String(meetingId), error: err.message });
    await sendConfirmation(meetingId, { afterMissedCall: true, force: true }).catch((e) => logger.warn("[visit-confirm] fallback failed", { error: e.message }));
    return { called: false, error: err.message };
  }
}

/**
 * Called right after a visit is booked / moved (tenant context). When AI
 * calling is ON, the confirmation call goes out within ~1 minute instead of
 * waiting for the next scheduler tick.
 */
function onVisitBooked(meeting) {
  try {
    const org = tenantContext.getOrg();
    const meetingId = meeting?._id;
    if (!meetingId) return;
    const run = async () => {
      if (!(await voiceReady())) return; // no calling → WhatsApp scheduler handles it
      const settings = await settingsService.getOrCreateSettings();
      const cfg = settings.visitConfirm || {};
      if (cfg.callEnabled === false) return; // client switched AI calls OFF
      if (org && !require("../saas/subscription").subscriptionState(org).active) return;
      if (!inCallingHours(cfg)) return; // the scheduler calls when calling hours start
      const res = await firstCall(meetingId);
      logger.info("[visit-confirm] instant confirmation call", { meeting: String(meetingId), ...res });
    };
    settingsService.getOrCreateSettings().then((settings) => {
      const minutes = Number.isFinite(settings.visitConfirm?.callDelayMinutes) ? settings.visitConfirm.callDelayMinutes : 1;
      if (minutes > 10) return; // longer delays are handled by the scheduler
      const delay = Math.max(20 * 1000, minutes * 60 * 1000);
      const t = setTimeout(() => {
        (org ? orgService.runForOrg(org._id, run) : run()).catch((err) => logger.warn("[visit-confirm] instant call failed", { error: err.message }));
      }, delay);
      t.unref?.();
    }).catch(() => {});
  } catch (err) {
    logger.warn("[visit-confirm] onVisitBooked failed", { error: err.message });
  }
}

/** Sends a WhatsApp text inside the 24h window and records it in the inbox. Best-effort. */
async function sendChat(lead, text) {
  const conversation = await Conversation.findOne({ leadId: lead._id });
  if (!conversation || conversation.optedOut) return false;
  const lastInbound = conversation.lastInboundAt ? new Date(conversation.lastInboundAt).getTime() : 0;
  if (Date.now() - lastInbound >= 24 * 60 * 60 * 1000) return false;
  const { messageId } = await metaWhatsappClient.sendTextMessage({ phone: lead.phone, text });
  await recordOutboundMessage({ conversationId: conversation._id, leadId: lead._id, text, sender: "ai", whatsappMessageId: messageId, ownerId: conversation.ownerId }).catch(() => {});
  return true;
}

/**
 * What the customer decided ON the call → a short WhatsApp note so the chat
 * stays in sync (and, after a "no", the bot asks for a new date / follow-up).
 */
async function afterCallOutcome(meeting, lead, outcome, extracted = {}) {
  if (!lead?.phone) return;
  const conversation = await Conversation.findOne({ leadId: lead._id }).select("language").lean();
  const english = isEnglish(conversation);
  let project = "";
  if (meeting?.propertyId) {
    const p = meeting.propertyId.projectName ? meeting.propertyId : await require("../../models/Property").findById(meeting.propertyId).select("projectName mapsLink location city").lean();
    project = p?.projectName ? `${p.projectName}${p.location || p.city ? `, ${[p.location, p.city].filter(Boolean).join(", ")}` : ""}${p.mapsLink ? `\n📍 ${p.mapsLink}` : ""}` : "";
  }
  const when = meeting ? labels(meeting) : null;
  let text = null;
  if ((outcome === "confirmed" || outcome === "reschedule") && when) {
    text = english
      ? `✅ Your site visit is confirmed for ${when.dateLabel === "aaj" ? "today" : when.dateLabel === "kal" ? "tomorrow" : when.dateLabel} at ${when.timeLabel}.${project ? `\n🏠 ${project}` : ""}\nSee you there! 🙏`
      : `✅ Aapki site visit ${when.dateLabel} ${when.timeLabel} baje ke liye confirm hai.${project ? `\n🏠 ${project}` : ""}\nMilte hain! 🙏`;
  } else if (outcome === "follow_up" && extracted.follow_up_date) {
    const d = new Date(`${extracted.follow_up_date}T00:00:00+05:30`).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
    text = english ? `Sure 🙏 We'll get in touch with you around ${d}. Message us here anytime if you'd like to visit earlier.` : `Theek hai 🙏 Hum aapse ${d} ke aas-paas sampark karenge. Pehle visit karna ho to yahin message kar dijiye.`;
  } else if (outcome === "declined") {
    text = english
      ? "Thanks for your time on the call 🙏 Which other day and time would suit you for the visit? Or tell me when we should get back to you."
      : "Call par baat karne ke liye dhanyavaad 🙏 Aap kis din aur kitne baje visit ke liye aa sakte hain? Ya bata dijiye hum aapse kab dobara baat karein.";
  }
  if (!text) return;
  const sent = await sendChat(lead, text).catch((err) => {
    logger.warn("[visit-confirm] post-call WhatsApp failed", { error: err.message });
    return false;
  });
  if (sent && meeting && outcome === "declined") {
    await Meeting.updateOne({ _id: meeting._id }, { $set: { "confirmation.sentAt": new Date() } }).catch(() => {});
  }
}

/**
 * Called once a confirmation call has ended (tenant context).
 * Not answered / failed / unclear → WhatsApp fallback right away.
 */
async function afterCallResult(meeting, { status, answered }) {
  emitMeeting(meeting);
  const s = String(status || "").toLowerCase();
  const final = s === "completed" || CALL_FAIL.includes(s);
  if (!final) return;
  const fresh = await Meeting.findById(meeting._id);
  if (!fresh) return;
  if (["confirmed", "declined"].includes(fresh.confirmation?.status)) {
    const lead = await Lead.findById(fresh.leadId).select("name phone");
    if (lead && fresh.confirmation.confirmedVia === "call") await notifyOwner(fresh.ownerId, lead, fresh, fresh.confirmation.status, "call");
    return;
  }
  if (fresh.status === "cancelled" || fresh.confirmation?.whatsappFallbackAt) return; // nothing to ask / already sent
  const settings = await settingsService.getOrCreateSettings();
  const retries = Number(settings.visitConfirm?.callRetries) || 0;
  if (!answered && (fresh.confirmation?.callAttempts || 0) <= retries) return; // the tick will retry the call first
  try {
    await sendConfirmation(fresh._id, { afterMissedCall: true, force: true });
    logger.info("[visit-confirm] Call not confirmed → WhatsApp fallback sent", { meeting: String(fresh._id), status: s, answered });
  } catch (err) {
    logger.warn("[visit-confirm] WhatsApp fallback failed", { meeting: String(fresh._id), error: err.message });
  }
}

function inCallingHours(cfg) {
  const h = istHour();
  const start = Number.isFinite(cfg.callStartHour) ? cfg.callStartHour : 10;
  const end = Number.isFinite(cfg.callEndHour) ? cfg.callEndHour : 19;
  return h >= start && h < end;
}

async function runCallFirst(cfg, horizonDays) {
  const inHours = inCallingHours(cfg); // only phone calls wait for calling hours; WhatsApp can go any time
  const delayMs = (Number.isFinite(cfg.callDelayMinutes) ? cfg.callDelayMinutes : 1) * 60000;
  const retries = Number(cfg.callRetries) || 0;

  // 1) New visits → first call (claimed atomically inside firstCall)
  const fresh = !inHours ? [] : await Meeting.find({
    status: { $in: ["scheduled", "rescheduled"] },
    "confirmation.calledAt": null,
    "confirmation.status": { $nin: ["confirmed", "declined"] },
    preferredDate: { $gte: istDay(0), $lte: istDay(horizonDays) },
    updatedAt: { $lte: new Date(Date.now() - delayMs) },
  }).select("_id").limit(40).lean();
  for (const meeting of fresh) {
    await firstCall(meeting._id).catch((err) => logger.warn("[visit-confirm] first call failed", { meeting: String(meeting._id), error: err.message }));
  }

  // 2) Calls that ended without a confirmation → retry (if configured) or WhatsApp.
  //    Also closes calls whose hang-up result never arrived (stale).
  const pendingCalls = await Meeting.find({
    status: { $in: ["scheduled", "rescheduled"] },
    "confirmation.calledAt": { $ne: null },
    "confirmation.whatsappFallbackAt": null,
    "confirmation.status": { $nin: ["confirmed", "declined"] },
    preferredDate: { $gte: istDay(-1), $lte: istDay(horizonDays) },
  }).limit(60);
  for (const meeting of pendingCalls) {
    const c = meeting.confirmation || {};
    const st = String(c.callStatus || "").toLowerCase();
    const age = Date.now() - new Date(c.calledAt).getTime();
    const ended = CALL_FAIL.includes(st) || st === "completed";
    // A WhatsApp fallback that failed (e.g. 24h window closed, no template) is retried at most every 30 min.
    if (c.error && c.lastAttemptAt && Date.now() - new Date(c.lastAttemptAt).getTime() < 30 * 60 * 1000 && age > CALL_STALE_MS) continue;
    try {
      if (!ended) {
        if (age < CALL_STALE_MS) continue; // call still ringing / in progress
        // No hang-up callback arrived → close the call ourselves (this also sends the WhatsApp fallback).
        const log = c.callLogId ? await CallLog.findById(c.callLogId) : null;
        if (log && !log.finalizedAt) {
          await require("../voice/voiceService").finalizeCall(log, { status: log.answeredAt ? "completed" : "no-answer", hangupCause: "no_callback" });
          continue;
        }
        await sendConfirmation(meeting._id, { afterMissedCall: true, force: true });
        continue;
      }
      if (age < 2 * 60 * 1000) continue; // give the hang-up handler a moment to do it first
      const at = visitDate(meeting);
      if (st !== "completed" && inHours && (c.callAttempts || 0) <= retries && age > 60 * 60 * 1000 && at && at.getTime() - Date.now() > 45 * 60 * 1000) {
        await callConfirmation(meeting._id);
      } else if (st === "completed" || (c.callAttempts || 0) > retries) {
        await sendConfirmation(meeting._id, { afterMissedCall: true, force: true });
      }
    } catch (err) {
      logger.warn("[visit-confirm] retry/fallback failed", { meeting: String(meeting._id), error: err.message });
    }
  }
}

async function runWhatsappOnly(cfg) {
  const hours = Math.min(Math.max(Number(cfg.hoursBefore) || 24, 1), 72);
  const horizon = Date.now() + hours * 3600 * 1000;
  const candidates = await Meeting.find({
    status: { $in: ["scheduled", "rescheduled"] },
    dateTentative: { $ne: true }, // date still being agreed in the chat
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
}

/** Scheduler: every company (WhatsApp confirmation is always on; AI call when the client has it switched on). */
async function tick() {
  const companies = await Settings.find({ $or: [{ "visitConfirm.enabled": { $ne: false } }, { "visitConfirm.callEnabled": { $ne: false } }] }).select("orgId visitConfirm").lean();
  const voiceOk = await voiceReady();
  for (const s of companies) {
    const cfg = s.visitConfirm || {};
    const run = async () => {
      const org = tenantContext.getOrg();
      if (org && !require("../saas/subscription").subscriptionState(org).active) return; // expired / suspended company
      const aiCalls = cfg.callEnabled !== false && voiceOk;
      if (aiCalls) await runCallFirst(cfg, 7);
      else if (cfg.enabled !== false) await runWhatsappOnly(cfg);
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
    CallLog.find({ trigger: "visit_confirmation", createdAt: { $gte: new Date(Date.now() - days * 86400000) }, ...(ownerId ? { ownerId } : {}) }).select("status durationSec billedMinutes").lean(),
  ]);
  const out = {
    days,
    visits: visits.length,
    upcoming: visits.filter((v) => v.preferredDate >= istDay(0) && ["scheduled", "rescheduled"].includes(v.status)).length,
    callsPlaced: calls.length,
    callsAnswered: calls.filter((c) => String(c.status).toLowerCase() === "completed" && (c.durationSec || 0) > 5).length,
    callsNotAnswered: calls.filter((c) => CALL_FAIL.includes(String(c.status).toLowerCase())).length,
    callsMissed: calls.filter((c) => CALL_FAIL.includes(String(c.status).toLowerCase()) || (String(c.status).toLowerCase() === "completed" && (c.durationSec || 0) <= 5)).length,
    callMinutes: calls.reduce((n, c) => n + (c.billedMinutes || 0), 0),
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

/**
 * Every AI confirmation call (who was called, who picked up, who did not) for the
 * "AI calls" list on the Visit confirmation page. Tenant context required.
 */
async function callsList({ days = 30, result = "all", limit = 100 } = {}) {
  const ownerId = tenantContext.ownerId();
  const rows = await CallLog.find({
    trigger: "visit_confirmation",
    createdAt: { $gte: new Date(Date.now() - days * 86400000) },
    ...(ownerId ? { ownerId } : {}),
  })
    .sort({ createdAt: -1 })
    .limit(300)
    .populate("leadId", "name phone")
    .populate({ path: "meetingId", select: "preferredDate preferredTime status confirmation propertyId", populate: { path: "propertyId", select: "projectName" } })
    .lean();

  const items = rows.map((c) => {
    const st = String(c.status || "").toLowerCase();
    const stale = !CALL_FAIL.includes(st) && st !== "completed" && Date.now() - new Date(c.createdAt).getTime() > CALL_STALE_MS;
    const picked = st === "completed" && (c.durationSec || 0) > 5;
    const status = picked ? "answered" : CALL_FAIL.includes(st) || st === "completed" || stale ? "missed" : "in_progress";
    const m = c.meetingId || {};
    const conf = m.confirmation || {};
    let outcome = null; // what the customer decided on this call
    if (status === "answered") {
      if (c.outcome === "reschedule") outcome = "confirmed";
      else if (["follow_up", "not_interested", "declined"].includes(c.outcome)) outcome = "declined";
      else if (c.outcome === "confirmed") outcome = "confirmed";
      else outcome = conf.confirmedVia === "call" && ["confirmed", "declined"].includes(conf.status) ? conf.status : "unclear";
    }
    return {
      id: String(c._id),
      meetingId: m._id ? String(m._id) : null,
      meetingStatus: m.status || null,
      at: c.createdAt,
      lead: { name: c.leadId?.name || "Lead", phone: c.leadId?.phone || "" },
      project: m.propertyId?.projectName || "",
      visitDate: m.preferredDate || null,
      visitTime: m.preferredTime || null,
      status,
      outcome,
      durationSec: c.durationSec || 0,
      minutes: c.billedMinutes || 0,
      language: c.language || null,
      whatsappFallback: Boolean(conf.whatsappFallbackAt),
      attempts: conf.callAttempts || 1,
      summary: c.summary || "",
      result: c.outcome || null, // confirmed / reschedule / follow_up / declined / callback_later / not_interested / unclear
      transcript: (c.turns || []).slice(0, 20).map((t) => ({ role: t.role, text: t.text })),
      recordingUrl: c.recordingUrl || null,
      error: c.error || null,
    };
  });
  const summary = {
    total: items.length,
    answered: items.filter((i) => i.status === "answered").length,
    missed: items.filter((i) => i.status === "missed").length,
    inProgress: items.filter((i) => i.status === "in_progress").length,
  };
  const filtered = result === "all" ? items : items.filter((i) => i.status === result);
  return { summary, items: filtered.slice(0, Math.min(Math.max(Number(limit) || 100, 1), 300)) };
}

let handle = null;
function startVisitConfirmationScheduler() {
  if (handle) return;
  const run = () => withLock("visit-confirmation", TICK_MS - 10000, tick).catch((err) => logger.error("[visit-confirm] tick failed", { error: err.message }));
  handle = setInterval(run, TICK_MS);
  setTimeout(run, 30000).unref?.();
  logger.info("[visit-confirm] Scheduler started (every 2 min)");
}

module.exports = {
  labels,
  callsList,
  sendConfirmation,
  callConfirmation,
  firstCall,
  onVisitBooked,
  afterCallResult,
  afterCallOutcome,
  notifyOwner,
  handleReply,
  startVisitConfirmationScheduler,
  tick,
  stats,
  inCallingHours,
  YES_RE,
  NO_RE,
  CALL_FAIL,
};
