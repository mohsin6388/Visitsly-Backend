/**
 * Bulk messaging safety rules — WhatsApp + email campaigns.
 *
 * Every campaign message goes through these checks. They protect the
 * customer's WhatsApp number from getting flagged by Meta, protect the shared
 * email sending domain from spam blocks, and keep campaigns inside the rules
 * that apply in India (TRAI commercial-communication norms, DPDP Act 2023)
 * and the UAE (TDRA marketing-message rules, PDPL) as well as Meta's
 * WhatsApp Business Messaging Policy and Gmail/Yahoo bulk-sender rules.
 *
 *   1. Consent      – opted-out / do-not-contact / bounced contacts are never messaged.
 *   2. Opt-out      – STOP / UNSUBSCRIBE (English, Hindi/Hinglish, Arabic) on WhatsApp,
 *                     one-click unsubscribe link + List-Unsubscribe header on email.
 *   3. Frequency    – max 1 marketing message per contact per channel per
 *                     MARKETING_MIN_GAP_HOURS (24h), max MARKETING_MAX_PER_WEEK (3) per 7 days.
 *   4. Quiet hours  – marketing goes out only between 09:00 and 21:00 local time
 *                     (Asia/Kolkata or Asia/Dubai); jobs due at night wait for morning.
 *   5. Daily caps   – per company: WhatsApp WA_DAILY_LIMIT (1,000), email
 *                     EMAIL_DAILY_LIMIT (2,000) with a 14-day warm-up for new senders.
 *   6. Auto-pause   – a campaign stops by itself when failures, opt-outs,
 *                     bounces or spam complaints cross safe limits, and when
 *                     Meta marks the WhatsApp number's quality RED / FLAGGED.
 *
 * All numbers can be tuned in .env (see BULK_OUTREACH.md).
 */
const crypto = require("crypto");
const env = require("../../config/env");
const logger = require("../../utils/logger");
const { getRegion } = require("../../config/plans");

const POLICY_VERSION = "2026-11-v1";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const num = (name, fallback) => {
  const v = Number.parseFloat(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
};

const RULES = {
  minGapHours: num("MARKETING_MIN_GAP_HOURS", 24),
  maxPerWeek: num("MARKETING_MAX_PER_WEEK", 3),
  quietStart: process.env.QUIET_HOURS_START || "21:00", // no marketing from…
  quietEnd: process.env.QUIET_HOURS_END || "09:00", // …until
  whatsappDailyLimit: num("WA_DAILY_LIMIT", 1000),
  emailDailyLimit: num("EMAIL_DAILY_LIMIT", 2000),
  emailWarmup: String(process.env.EMAIL_WARMUP || "true").toLowerCase() !== "false",
  // Auto-pause guard
  minSample: num("SAFETY_MIN_SAMPLE", 50),
  maxFailRate: num("SAFETY_MAX_FAIL_RATE", 0.2),
  maxOptOutRate: num("SAFETY_MAX_OPTOUT_RATE", 0.05),
  maxBounceRate: num("SAFETY_MAX_BOUNCE_RATE", 0.05),
  maxComplaintRate: num("SAFETY_MAX_COMPLAINT_RATE", 0.003),
};

/* ------------------------------------------------------------------ */
/* 1–2. Opt-out / opt-in keywords                                      */
/* ------------------------------------------------------------------ */

// Matched only when the WHOLE message is the keyword, so "cancel my visit"
// or "stop by tomorrow" is never treated as an opt-out.
const OPT_OUT_KEYWORDS = new Set([
  // English
  "stop", "stop all", "stopall", "unsubscribe", "opt out", "optout", "opt-out",
  "remove me", "do not message", "dont message", "don't message", "no more messages",
  // Hindi / Hinglish
  "band karo", "band kar do", "message mat bhejo", "mat bhejo", "nahi chahiye messages",
  "बंद करो", "बंद", "मत भेजो",
  // Arabic
  "توقف", "إيقاف", "ايقاف", "الغاء", "إلغاء", "الغاء الاشتراك", "إلغاء الاشتراك", "لا ترسل",
]);
const OPT_IN_KEYWORDS = new Set([
  "start", "subscribe", "unstop", "resume", "shuru karo", "शुरू करो", "ابدأ", "اشتراك",
]);

function normalizeKeyword(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[.!?,;:"'`~*_()[\]{}…،؟]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** "opt_out" | "opt_in" | null */
function classifyKeyword(text) {
  const t = normalizeKeyword(text);
  if (!t || t.length > 40) return null;
  if (OPT_OUT_KEYWORDS.has(t)) return "opt_out";
  if (OPT_IN_KEYWORDS.has(t)) return "opt_in";
  return null;
}

const CONFIRM_TEXT = {
  opt_out: {
    in: "Aapko ab humari taraf se marketing messages nahi aayenge. Dobara shuru karne ke liye START bhejein.",
    ae: "You will no longer receive marketing messages from us. Reply START to subscribe again.\nلن تصلك رسائل تسويقية بعد الآن. أرسل START للاشتراك مجددًا.",
  },
  opt_in: {
    in: "Aapko dobara updates milenge. Kabhi bhi band karne ke liye STOP bhejein.",
    ae: "You are subscribed again. Reply STOP at any time to unsubscribe.\nتم تفعيل الاشتراك. أرسل STOP لإلغاء الاشتراك في أي وقت.",
  },
};

function confirmationText(kind, org) {
  return CONFIRM_TEXT[kind]?.[getRegion(org).code] || CONFIRM_TEXT[kind]?.in || "";
}

/**
 * Applies a STOP / START reply to the lead: updates consent, cancels queued
 * WhatsApp campaign messages, and counts the opt-out on the campaign that
 * last messaged this contact (feeds the auto-pause guard).
 */
async function applyWhatsAppKeyword(lead, kind, { source = "keyword" } = {}) {
  const Lead = require("../../models/Lead");
  const OutboundJob = require("../../models/OutboundJob");
  const Campaign = require("../../models/Campaign");
  const now = new Date();
  const status = kind === "opt_out" ? "opted_out" : "opted_in";
  await Lead.updateOne(
    { _id: lead._id },
    { $set: { "consent.whatsapp.status": status, "consent.whatsapp.source": source, "consent.whatsapp.at": now } },
  );
  if (kind !== "opt_out") return;

  await OutboundJob.updateMany(
    { leadId: lead._id, channel: "whatsapp", status: { $in: ["pending", "paused"] } },
    { $set: { status: "cancelled", lastError: "Contact opted out (STOP)" } },
  );
  const last = await OutboundJob.findOne({
    leadId: lead._id,
    channel: "whatsapp",
    status: "sent",
    campaignId: { $ne: null },
    sentAt: { $gte: new Date(Date.now() - 7 * DAY) },
  })
    .sort({ sentAt: -1 })
    .select("campaignId")
    .lean();
  if (last?.campaignId) {
    await Campaign.updateOne({ _id: last.campaignId }, { $inc: { "safety.optOuts": 1 } });
    evaluateCampaignHealth(last.campaignId).catch(() => {});
  }
}

/** Email unsubscribe (link click / one-click POST / provider event). */
async function applyEmailOptOut(leadId, reason = "unsubscribed") {
  const Lead = require("../../models/Lead");
  const OutboundJob = require("../../models/OutboundJob");
  const now = new Date();
  const $set = { "consent.email.status": "opted_out", "consent.email.source": reason, "consent.email.at": now };
  if (["bounced", "complained", "unsubscribed"].includes(reason)) {
    $set["emailSuppressed.reason"] = reason;
    $set["emailSuppressed.at"] = now;
  }
  await Lead.updateOne({ _id: leadId }, { $set });
  await OutboundJob.updateMany(
    { leadId, channel: "email", status: { $in: ["pending", "paused"] } },
    { $set: { status: "cancelled", lastError: `Email ${reason}` } },
  );
}

/* ------------------------------------------------------------------ */
/* 1. Consent / suppression                                            */
/* ------------------------------------------------------------------ */

const SKIP_LABELS = {
  do_not_contact: "Do-not-contact",
  whatsapp_opted_out: "WhatsApp opt-out (STOP)",
  email_unsubscribed: "Email unsubscribed",
  email_bounced: "Email bounced earlier",
  email_complained: "Marked email as spam earlier",
  contacted_recently: "Already messaged in the last 24 hours",
  weekly_cap: "Weekly message limit reached for this contact",
};

/** Reason this contact must NOT get a campaign message on `channel`, or null. */
function suppressionReason(lead, channel) {
  if (!lead) return "do_not_contact";
  if (lead.doNotContact) return "do_not_contact";
  if (channel === "whatsapp") {
    if (lead.consent?.whatsapp?.status === "opted_out") return "whatsapp_opted_out";
    return null;
  }
  if (lead.emailSuppressed?.reason === "bounced") return "email_bounced";
  if (lead.emailSuppressed?.reason === "complained") return "email_complained";
  if (lead.consent?.email?.status === "opted_out" || lead.emailSuppressed?.reason === "unsubscribed") {
    return "email_unsubscribed";
  }
  return null;
}

/** Mongo filter that excludes suppressed contacts for a channel (used at launch). */
function eligibleFilter(channel) {
  const base = { doNotContact: { $ne: true } };
  if (channel === "whatsapp") return { ...base, "consent.whatsapp.status": { $ne: "opted_out" } };
  return { ...base, "consent.email.status": { $ne: "opted_out" }, "emailSuppressed.reason": { $in: [null] } };
}

/* ------------------------------------------------------------------ */
/* 3. Frequency caps                                                   */
/* ------------------------------------------------------------------ */

async function frequencyReason(lead, channel, now = Date.now()) {
  const last = lead?.lastMarketingAt?.[channel];
  if (RULES.minGapHours > 0 && last && now - new Date(last).getTime() < RULES.minGapHours * HOUR) {
    return "contacted_recently";
  }
  if (RULES.maxPerWeek > 0) {
    const OutboundJob = require("../../models/OutboundJob");
    const sentThisWeek = await OutboundJob.countDocuments({
      leadId: lead._id,
      channel,
      status: "sent",
      sentAt: { $gte: new Date(now - 7 * DAY) },
    });
    if (sentThisWeek >= RULES.maxPerWeek) return "weekly_cap";
  }
  return null;
}

async function markMarketingSent(leadId, channel) {
  const Lead = require("../../models/Lead");
  await Lead.updateOne({ _id: leadId }, { $set: { [`lastMarketingAt.${channel}`]: new Date() } });
}

/* ------------------------------------------------------------------ */
/* 4. Quiet hours                                                      */
/* ------------------------------------------------------------------ */

const toMin = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

function quietWindow(org) {
  const start = toMin(org?.messaging?.quietHoursStart) ?? toMin(RULES.quietStart) ?? 21 * 60;
  const end = toMin(org?.messaging?.quietHoursEnd) ?? toMin(RULES.quietEnd) ?? 9 * 60;
  return { start, end, timezone: getRegion(org).timezone };
}

/** Minutes past local midnight in a timezone. */
function localMinutes(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(date)
    .reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function inQuiet(minutes, { start, end }) {
  if (start === end) return false;
  return start > end ? minutes >= start || minutes < end : minutes >= start && minutes < end;
}

/** True when marketing must not go out right now for this company. */
function isQuietHours(org, date = new Date()) {
  const w = quietWindow(org);
  return inQuiet(localMinutes(date, w.timezone), w);
}

/** Next moment marketing may go out (now if not in quiet hours). */
function nextSendTime(org, date = new Date()) {
  const w = quietWindow(org);
  const nowMin = localMinutes(date, w.timezone);
  if (!inQuiet(nowMin, w)) return date;
  let wait = w.end - nowMin;
  if (wait <= 0) wait += 24 * 60;
  const out = new Date(date.getTime() + wait * 60 * 1000);
  out.setSeconds(0, 0);
  // Small random spread so many companies don't all start at 09:00:00 sharp.
  return new Date(out.getTime() + Math.floor(Math.random() * 10) * 60 * 1000);
}

/**
 * Moves a campaign's daily send time out of quiet hours (e.g. "22:30" → "09:00").
 * Returns { sendTime, shifted }.
 */
function clampSendTime(org, sendTime) {
  const w = quietWindow(org);
  const m = toMin(sendTime);
  if (m === null || !inQuiet(m, w)) return { sendTime, shifted: false };
  const hh = String(Math.floor(w.end / 60)).padStart(2, "0");
  const mm = String(w.end % 60).padStart(2, "0");
  return { sendTime: `${hh}:${mm}`, shifted: true };
}

/** Validates a campaign's daily send time (HH:mm) against quiet hours. */
function assertSendTimeAllowed(org, sendTime) {
  const w = quietWindow(org);
  const m = toMin(sendTime);
  if (m === null) return;
  if (inQuiet(m, w)) {
    const ApiError = require("../../utils/ApiError");
    const fmt = (x) => `${String(Math.floor(x / 60)).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}`;
    throw ApiError.badRequest(
      `Marketing messages ${fmt(w.end)} se ${fmt(w.start)} (local time) ke beech hi bhej sakte hain. Send time ${fmt(w.end)}–${fmt(w.start)} ke andar rakhein.`,
      { code: "QUIET_HOURS" },
    );
  }
}

/* ------------------------------------------------------------------ */
/* 5. Daily caps (+ email warm-up)                                     */
/* ------------------------------------------------------------------ */

async function emailWarmupCap(ownerId, now = Date.now()) {
  if (!RULES.emailWarmup) return Infinity;
  const EmailMessage = require("../../models/EmailMessage");
  const first = await EmailMessage.findOne({ ownerId, kind: "campaign", direction: "outbound", sentAt: { $ne: null } })
    .sort({ sentAt: 1 })
    .select("sentAt")
    .lean();
  if (!first?.sentAt) return 100;
  const days = (now - new Date(first.sentAt).getTime()) / DAY;
  if (days < 3) return 100;
  if (days < 7) return 300;
  if (days < 14) return 1000;
  return Infinity;
}

async function dailyCap(org, ownerId, channel) {
  if (channel === "whatsapp") {
    const v = org?.messaging?.whatsappDailyLimit;
    return v === null || v === undefined ? RULES.whatsappDailyLimit : v;
  }
  const v = org?.messaging?.emailDailyLimit;
  const base = v === null || v === undefined ? RULES.emailDailyLimit : v;
  return Math.min(base, await emailWarmupCap(ownerId));
}

async function sentLast24h(ownerId, channel, now = Date.now()) {
  const OutboundJob = require("../../models/OutboundJob");
  return OutboundJob.countDocuments({ ownerId, channel, status: "sent", sentAt: { $gte: new Date(now - DAY) } });
}

/** { ok, cap, used } — whether one more campaign message may go out in the rolling 24h. */
async function dailyCapStatus(org, ownerId, channel) {
  const cap = await dailyCap(org, ownerId, channel);
  if (!Number.isFinite(cap)) return { ok: true, cap: null, used: null };
  const used = await sentLast24h(ownerId, channel);
  return { ok: used < cap, cap, used };
}

/* ------------------------------------------------------------------ */
/* 6. Auto-pause guard                                                 */
/* ------------------------------------------------------------------ */

async function notifyOwner(ownerId, payload) {
  try {
    const Notification = require("../../models/Notification");
    await Notification.create({ userId: ownerId, ...payload });
    require("../../sockets").emitToUser(ownerId, "notification:new", {});
  } catch (err) {
    logger.warn("[safety] Could not create notification", { error: err.message });
  }
}

/** Pauses a campaign and all its queued messages, with a reason the customer sees. */
async function pauseCampaign(campaignId, reason) {
  const Campaign = require("../../models/Campaign");
  const OutboundJob = require("../../models/OutboundJob");
  const campaign = await Campaign.findOneAndUpdate(
    { _id: campaignId, status: "active" },
    { $set: { status: "paused", "safety.autoPausedAt": new Date(), "safety.autoPausedReason": reason } },
    { new: true },
  ).lean();
  if (!campaign) return false;
  await OutboundJob.updateMany(
    { campaignId, status: "pending" },
    { $set: { status: "paused", lastError: `Safety pause: ${reason}` } },
  );
  logger.warn(`[safety] Campaign ${campaignId} auto-paused: ${reason}`);
  await notifyOwner(campaign.ownerId, {
    type: "campaign_safety_pause",
    title: `Campaign "${campaign.name}" safety ke liye ruk gaya`,
    body: `${reason}. Contact list aur message check karein, phir campaign resume karein.`,
    link: "/outreach",
  });
  return true;
}

const campaignChecks = new Map(); // campaignId -> last check ts

/**
 * Looks at a campaign's results so far and pauses it when they show the list
 * or the message is hurting the sender's reputation.
 */
async function evaluateCampaignHealth(campaignId, { force = false } = {}) {
  const key = String(campaignId);
  if (!force && Date.now() - (campaignChecks.get(key) || 0) < 30 * 1000) return null;
  campaignChecks.set(key, Date.now());

  const mongoose = require("mongoose");
  const Campaign = require("../../models/Campaign");
  const OutboundJob = require("../../models/OutboundJob");
  const EmailMessage = require("../../models/EmailMessage");
  const campaign = await Campaign.findById(campaignId).lean();
  if (!campaign || campaign.status !== "active") return null;

  const id = new mongoose.Types.ObjectId(key);
  const rows = await OutboundJob.aggregate([
    { $match: { ownerId: campaign.ownerId, campaignId: id, status: { $in: ["sent", "failed"] } } },
    { $group: { _id: { channel: "$channel", status: "$status" }, n: { $sum: 1 } } },
  ]);
  const count = (channel, status) => rows.find((r) => r._id.channel === channel && r._id.status === status)?.n || 0;

  // WhatsApp: failures + STOP replies.
  const waSent = count("whatsapp", "sent");
  const waFailed = count("whatsapp", "failed");
  const waTotal = waSent + waFailed;
  if (waTotal >= RULES.minSample) {
    if (waFailed / waTotal > RULES.maxFailRate) {
      return pauseCampaign(campaignId, `WhatsApp failures ${Math.round((waFailed / waTotal) * 100)}% (limit ${Math.round(RULES.maxFailRate * 100)}%) — list mein galat / non-WhatsApp numbers hain`);
    }
    const optOuts = campaign.safety?.optOuts || 0;
    if (waSent && optOuts / waSent > RULES.maxOptOutRate) {
      return pauseCampaign(campaignId, `${optOuts} logon ne STOP bheja (${Math.round((optOuts / waSent) * 100)}%) — message ya audience badlein`);
    }
  }

  // Email: bounces + spam complaints.
  const emSent = count("email", "sent");
  if (emSent >= RULES.minSample) {
    const [bounced, complained] = await Promise.all([
      EmailMessage.countDocuments({ ownerId: campaign.ownerId, campaignId: id, status: "bounced" }),
      EmailMessage.countDocuments({ ownerId: campaign.ownerId, campaignId: id, status: "complained" }),
    ]);
    if (bounced / emSent > RULES.maxBounceRate) {
      return pauseCampaign(campaignId, `Email bounce ${Math.round((bounced / emSent) * 100)}% (limit ${Math.round(RULES.maxBounceRate * 100)}%) — purani / galat email list`);
    }
    if (complained / emSent > RULES.maxComplaintRate) {
      return pauseCampaign(campaignId, `${complained} logon ne email ko spam mark kiya — sirf opted-in contacts ko bhejein`);
    }
  }
  return null;
}

/**
 * Meta webhook `phone_number_quality_update` / account alerts. RED quality or
 * FLAGGED status → pause every WhatsApp campaign of that company.
 */
async function handleWhatsAppQuality(org, value) {
  const Organization = require("../../models/Organization");
  const OutboundJob = require("../../models/OutboundJob");
  const Campaign = require("../../models/Campaign");
  const event = String(value?.event || "").toUpperCase(); // FLAGGED | UNFLAGGED | DOWNGRADE | UPGRADE
  // Meta sends quality_rating on some events (GREEN / YELLOW / RED); FLAGGED implies RED.
  const rating = String(value?.quality_rating || (event === "FLAGGED" ? "RED" : "")).toUpperCase();
  const bad = event === "FLAGGED" || event === "DOWNGRADE" || rating === "RED";
  const $set = {};
  if (rating) $set["whatsapp.qualityRating"] = rating;
  if (bad) {
    $set["messaging.autoPausedAt"] = new Date();
    $set["messaging.autoPausedReason"] = `Meta ne WhatsApp number ko ${event || rating} kiya`;
  }
  if (Object.keys($set).length) await Organization.updateOne({ _id: org._id }, { $set });
  require("../saas/orgService").invalidate(org._id);
  if (!bad) return;

  const owner = org.ownerUserId;
  const reason = `Meta quality alert (${event || rating}) — WhatsApp campaigns ruk gaye taaki number block na ho`;
  await Campaign.updateMany(
    { ownerId: owner, status: "active", "channels.whatsapp": true },
    { $set: { status: "paused", "safety.autoPausedAt": new Date(), "safety.autoPausedReason": reason } },
  );
  await OutboundJob.updateMany(
    { ownerId: owner, channel: "whatsapp", status: "pending", campaignId: { $ne: null } },
    { $set: { status: "paused", lastError: `Safety pause: ${reason}` } },
  );
  await notifyOwner(owner, {
    type: "whatsapp_quality",
    title: "WhatsApp number quality alert",
    body: `${reason}. Kuch din sirf un logon ko message karein jo khud reply karte hain, aur list mein se purane / bina consent wale numbers hata dein.`,
    link: "/whatsapp",
  });
}

/* ------------------------------------------------------------------ */
/* Unsubscribe links                                                   */
/* ------------------------------------------------------------------ */

function unsubSecret() {
  return process.env.UNSUBSCRIBE_SECRET || `${env.jwt.accessSecret}::unsubscribe`;
}

function makeUnsubscribeToken(leadId, channel = "email") {
  const payload = Buffer.from(`${String(leadId)}.${channel}`).toString("base64url");
  const sig = crypto.createHmac("sha256", unsubSecret()).update(payload).digest("base64url").slice(0, 32);
  return `${payload}.${sig}`;
}

function readUnsubscribeToken(token) {
  const [payload, sig] = String(token || "").split(".");
  if (!payload || !sig) return null;
  const expected = crypto.createHmac("sha256", unsubSecret()).update(payload).digest("base64url").slice(0, 32);
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const [leadId, channel] = Buffer.from(payload, "base64url").toString("utf8").split(".");
  if (!/^[a-f\d]{24}$/i.test(leadId || "")) return null;
  return { leadId, channel: channel === "whatsapp" ? "whatsapp" : "email" };
}

/** Public URL for the unsubscribe link + List-Unsubscribe header. */
function unsubscribeUrl(leadId, channel = "email") {
  const base = String(process.env.PUBLIC_API_URL || "").replace(/\/$/, "");
  const token = makeUnsubscribeToken(leadId, channel);
  if (base) return `${base}/api/public/unsubscribe/${token}`;
  return `${String(env.appBaseUrl || "").replace(/\/$/, "")}/unsubscribe/${token}`;
}

/** One-click (RFC 8058) only works when the link points at the API itself. */
function oneClickSupported() {
  return /^https:\/\//i.test(String(process.env.PUBLIC_API_URL || ""));
}

module.exports = {
  POLICY_VERSION,
  RULES,
  SKIP_LABELS,
  classifyKeyword,
  confirmationText,
  applyWhatsAppKeyword,
  applyEmailOptOut,
  suppressionReason,
  eligibleFilter,
  frequencyReason,
  markMarketingSent,
  isQuietHours,
  nextSendTime,
  assertSendTimeAllowed,
  clampSendTime,
  dailyCap,
  dailyCapStatus,
  evaluateCampaignHealth,
  pauseCampaign,
  handleWhatsAppQuality,
  makeUnsubscribeToken,
  readUnsubscribeToken,
  unsubscribeUrl,
  oneClickSupported,
};
