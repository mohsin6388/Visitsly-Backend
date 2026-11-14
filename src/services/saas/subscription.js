const { limitsFor, getPlan } = require("../../config/plans");
const { usageFor } = require("./orgService");

const PAST_DUE_GRACE_DAYS = parseInt(
  process.env.PAST_DUE_GRACE_DAYS || "5",
  10,
);
const DAY = 24 * 60 * 60 * 1000;

/**
 * Is this company allowed to use the product right now?
 *   trialing  → until trialEndsAt
 *   active    → yes
 *   past_due  → yes for a short grace period after currentPeriodEnd
 *   suspended / cancelled → no (data stays readable + exportable)
 */
function subscriptionState(org, now = Date.now()) {
  if (!org)
    return { active: true, status: "none", reason: null, daysLeft: null };
  const status = org.status || "trialing";
  const out = {
    status,
    plan: org.plan,
    active: true,
    reason: null,
    daysLeft: null,
  };

  if (status === "trialing") {
    const end = org.trialEndsAt ? new Date(org.trialEndsAt).getTime() : 0;
    out.daysLeft = Math.max(0, Math.ceil((end - now) / DAY));
    if (!end || end < now) {
      out.active = false;
      out.reason =
        "Aapka free trial khatam ho gaya hai. Kaam jaari rakhne ke liye plan choose karein.";
    }
  } else if (status === "past_due") {
    const end = org.currentPeriodEnd
      ? new Date(org.currentPeriodEnd).getTime()
      : now;
    const graceEnd = end + PAST_DUE_GRACE_DAYS * DAY;
    out.daysLeft = Math.max(0, Math.ceil((graceEnd - now) / DAY));
    if (graceEnd < now) {
      out.active = false;
      out.reason =
        "Payment fail ho gaya hai. Billing page se payment update karein.";
    }
  } else if (status === "suspended") {
    out.active = false;
    out.reason =
      org.suspendedReason ||
      "Account suspend hai. PropAI support se baat karein.";
  } else if (status === "cancelled") {
    out.active = false;
    out.reason =
      "Subscription cancel ho chuka hai. Dobara shuru karne ke liye plan choose karein.";
  } else if (status === "active" && org.currentPeriodEnd) {
    out.daysLeft = Math.max(
      0,
      Math.ceil((new Date(org.currentPeriodEnd).getTime() - now) / DAY),
    );
  }
  return out;
}

/**
 * Checks one limit. `current` is what exists now, `adding` what the action
 * would add. Returns { ok, limit, current, message }.
 */
function checkLimit(org, key, current, adding = 1) {
  if (!org) return { ok: true, limit: null, current };
  const limit = limitsFor(org)[key];
  if (limit === null || limit === undefined)
    return { ok: true, limit: null, current };
  const ok = current + adding <= limit;
  const labels = {
    users: "users",
    contacts: "contacts",
    aiConversations: "AI conversations is mahine",
    whatsappNumbers: "WhatsApp numbers",
    campaignsPerMonth: "campaigns is mahine",
    bulkMessages: "bulk messages",
    aiRepliesPerContact: "AI replies per contact",
  };
  return {
    ok,
    limit,
    current,
    message: ok
      ? null
      : `${getPlan(org.plan).name} plan mein ${limit.toLocaleString("en-IN")} ${labels[key] || key} tak allowed hain (abhi ${current.toLocaleString("en-IN")}). Plan upgrade karein.`,
  };
}

function monthlyUsage(org) {
  return usageFor(org);
}

module.exports = { subscriptionState, checkLimit, monthlyUsage };

/**
 * Throws a 403 PLAN_LIMIT error when the current company would go over a
 * plan limit. No-op outside a tenant (legacy single-client mode).
 */
function assertWithinLimit(key, current, adding = 1) {
  const org = require("../../context/tenantContext").getOrg();
  if (!org) return { ok: true, limit: null, current };
  const result = checkLimit(org, key, current, adding);
  if (!result.ok) {
    const ApiError = require("../../utils/ApiError");
    throw new ApiError(403, result.message, {
      code: "PLAN_LIMIT",
      key,
      limit: result.limit,
      current,
    });
  }
  return result;
}

/** How many more of `key` the current company may add (Infinity if unlimited). */
function remainingFor(key, current) {
  const org = require("../../context/tenantContext").getOrg();
  if (!org) return Infinity;
  const limit = limitsFor(org)[key];
  if (limit === null || limit === undefined) return Infinity;
  return Math.max(0, limit - current);
}

module.exports.assertWithinLimit = assertWithinLimit;
module.exports.remainingFor = remainingFor;

/* ------------------------------------------------------------------ */
/* Bulk-message limit (WhatsApp + email campaigns)                     */
/* ------------------------------------------------------------------ */

/**
 * Bulk messages used so far. Trial = total for the whole trial (lifetime
 * counter); paid plans = this calendar month.
 */
function bulkUsedFor(org) {
  if (!org) return 0;
  const u = usageFor(org);
  const monthly = (u.messagesSent || 0) + (u.emailsSent || 0);
  if (org.plan === "trial" || org.status === "trialing") {
    // max() also covers trial companies created before the lifetime counter existed.
    return Math.max(Number(org.bulkMessagesTotal || 0), monthly);
  }
  return monthly;
}

/** How many more bulk messages this company may send (Infinity if unlimited). */
function bulkMessagesRemaining(org) {
  if (!org) return Infinity;
  const limit = limitsFor(org).bulkMessages;
  if (limit === null || limit === undefined) return Infinity;
  return Math.max(0, limit - bulkUsedFor(org));
}

/**
 * Throws a 403 PLAN_LIMIT error when launching a campaign of `planned`
 * messages would cross the bulk-message limit. No-op outside a tenant.
 */
function assertBulkMessagesAllowed(planned) {
  const org = require("../../context/tenantContext").getOrg();
  if (!org) return;
  const limit = limitsFor(org).bulkMessages;
  if (limit === null || limit === undefined) return;
  const used = bulkUsedFor(org);
  if (used + planned <= limit) return;
  const remaining = Math.max(0, limit - used);
  const planName = getPlan(org.plan).name;
  const message =
    remaining <= 0
      ? `${planName} plan mein ${limit.toLocaleString("en-IN")} bulk messages ki limit poori ho chuki hai. Aur messages bhejne ke liye plan upgrade karein.`
      : `${planName} plan mein ab sirf ${remaining.toLocaleString("en-IN")} bulk messages bache hain (limit ${limit.toLocaleString("en-IN")}), aapne ${planned.toLocaleString("en-IN")} select kiye hain. Contacts kam karein ya plan upgrade karein.`;
  const ApiError = require("../../utils/ApiError");
  throw new ApiError(403, message, {
    code: "PLAN_LIMIT",
    key: "bulkMessages",
    limit,
    current: used,
  });
}

/* ------------------------------------------------------------------ */
/* AI replies per contact                                              */
/* ------------------------------------------------------------------ */

/** { limit, replies, reached } for one conversation. limit null = no cap. */
function aiReplyLimitInfo(org, replies = 0) {
  const used = Number(replies) || 0;
  const limit = org ? limitsFor(org).aiRepliesPerContact : null;
  if (limit === null || limit === undefined)
    return { limit: null, replies: used, reached: false };
  return {
    limit,
    replies: used,
    reached: used >= limit,
    planName: getPlan(org.plan).name,
  };
}

module.exports.bulkUsedFor = bulkUsedFor;
module.exports.bulkMessagesRemaining = bulkMessagesRemaining;
module.exports.assertBulkMessagesAllowed = assertBulkMessagesAllowed;
module.exports.aiReplyLimitInfo = aiReplyLimitInfo;
