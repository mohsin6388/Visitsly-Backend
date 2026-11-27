const { limitsFor, getPlan, featuresFor, FEATURE_LABEL, cheapestPlanWith } = require("../../config/plans");
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
        "Your free trial has ended. Choose a plan to continue.";
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
        "Payment failed. Update your payment on the Billing page.";
    }
  } else if (status === "suspended") {
    out.active = false;
    out.reason =
      org.suspendedReason ||
      "Account suspended. Contact support.";
  } else if (status === "cancelled") {
    out.active = false;
    out.reason =
      "Subscription cancelled. Choose a plan to restart.";
  } else if (status === "active" && org.razorpay?.mode === "order" && org.currentPeriodEnd && new Date(org.currentPeriodEnd).getTime() < now) {
    // Paid per period (no auto-renew): grace days after the period ends, then read-only.
    const graceEnd = new Date(org.currentPeriodEnd).getTime() + PAST_DUE_GRACE_DAYS * DAY;
    out.daysLeft = Math.max(0, Math.ceil((graceEnd - now) / DAY));
    out.renewDue = true;
    if (graceEnd < now) {
      out.active = false;
      out.reason = "Your plan period has ended. Renew on the Billing page.";
    }
  } else if (status === "active" && org.currentPeriodEnd) {
    out.daysLeft = Math.max(
      0,
      Math.ceil((new Date(org.currentPeriodEnd).getTime() - now) / DAY),
    );
  }
  return out;
}

const LIMIT_LABELS = {
  users: "users",
  contacts: "contacts",
  aiConversations: "AI conversations",
  whatsappNumbers: "WhatsApp numbers",
  campaignsPerMonth: "campaigns",
  bulkMessages: "bulk messages",
  aiRepliesPerContact: "AI replies per contact",
};

function isTrial(org) {
  return Boolean(org) && (org.plan === "trial" || org.status === "trialing");
}

/**
 * Usage that counts against a limit. Free trial: monthly counters are
 * replaced by lifetime totals (the trial's limits are for the whole trial,
 * even if it crosses a month end). Paid plans: the monthly value passed in.
 */
function usedForLimit(org, key, monthly = 0) {
  const m = Number(monthly) || 0;
  if (!isTrial(org)) return m;
  const totals = org.usageTotals || {};
  if (key === "aiConversations") return Math.max(m, Number(totals.aiConversations) || 0);
  if (key === "campaignsPerMonth") return Math.max(m, Number(totals.campaigns) || 0);
  return m;
}

function limitMessage(org, key, limit, current) {
  const label = LIMIT_LABELS[key] || key;
  const n = (v) => Number(v).toLocaleString("en-IN");
  if (isTrial(org)) return `Free trial limit reached: ${n(limit)} ${label}. Upgrade to continue.`;
  const period = ["aiConversations", "campaignsPerMonth"].includes(key) ? " this month" : "";
  return `The ${getPlan(org.plan).name} plan allows up to ${n(limit)} ${label}${period} (now ${n(current)}). Upgrade your plan.`;
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
  const used = usedForLimit(org, key, current);
  const ok = used + adding <= limit;
  return {
    ok,
    limit,
    current: used,
    message: ok ? null : limitMessage(org, key, limit, used),
  };
}

function monthlyUsage(org) {
  return usageFor(org);
}

module.exports = { subscriptionState, checkLimit, monthlyUsage, usedForLimit, isTrial };

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
      current: result.current,
      trial: isTrial(org),
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
  const n = (v) => Number(v).toLocaleString("en-IN");
  let message;
  if (remaining <= 0) {
    message = isTrial(org)
      ? `Free trial limit reached: ${n(limit)} bulk messages. Upgrade to continue.`
      : `The ${planName} plan’s ${n(limit)} bulk message limit is reached. Upgrade to send more.`;
  } else {
    message = `Only ${n(remaining)} bulk messages left on ${isTrial(org) ? "your free trial" : planName} (limit ${n(limit)}), but ${n(planned)} are selected. Select fewer contacts or upgrade.`;
  }
  const ApiError = require("../../utils/ApiError");
  throw new ApiError(403, message, {
    code: "PLAN_LIMIT",
    key: "bulkMessages",
    limit,
    current: used,
    trial: isTrial(org),
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

/* ------------------------------------------------------------------ */
/* Plan features (enforced server-side)                                */
/* ------------------------------------------------------------------ */

/** true when the company's plan (plus per-org overrides) includes `feature`. Legacy (no org) = true. */
function hasFeature(org, feature) {
  if (!org) return true;
  return Boolean(featuresFor(org)[feature]);
}

function featureError(org, feature) {
  const label = FEATURE_LABEL[feature] || feature;
  const plan = cheapestPlanWith(feature);
  const message = isTrial(org)
    ? `${label} is not available on the free trial. Upgrade to ${plan ? `the ${plan.name} plan` : "a paid plan"} to use it.`
    : `${label} is not included in the ${getPlan(org.plan).name} plan. Upgrade${plan ? ` to ${plan.name}` : ""} to use it.`;
  const ApiError = require("../../utils/ApiError");
  // Same shape as other plan limits, so the app shows its Upgrade prompt.
  return new ApiError(403, message, {
    code: "PLAN_LIMIT",
    key: `feature:${feature}`,
    feature,
    requiredPlan: plan?.code || null,
    trial: isTrial(org),
  });
}

/** Throws 403 PLAN_LIMIT when the company (default: current tenant) lacks the feature. */
function assertFeature(feature, org = require("../../context/tenantContext").getOrg()) {
  if (!org) return; // legacy single-client mode
  if (!hasFeature(org, feature)) throw featureError(org, feature);
}

/** Express middleware: requireFeature('emailCampaigns'). Run after `authenticate`. */
function requireFeature(feature, { methods = null } = {}) {
  return (req, res, next) => {
    if (methods && !methods.includes(req.method)) return next();
    const org = req.org || require("../../context/tenantContext").getOrg();
    if (org && !hasFeature(org, feature)) return next(featureError(org, feature));
    return next();
  };
}

/* ------------------------------------------------------------------ */
/* AI calling minutes                                                  */
/* ------------------------------------------------------------------ */

/**
 * Where the company stands on AI calling minutes.
 *
 *  - plan allowance: limits.voiceMinutesIncluded per calendar month (IST),
 *    resets every month.
 *  - recharged packs (voiceMinute add-on): never reset. They are only used
 *    AFTER the monthly plan allowance, and every minute taken from a pack is
 *    counted in org.voicePrepaidUsed (lifetime).
 *  - unlimited: the admin set voiceMinutesIncluded to unlimited (null), or the
 *    company is Enterprise without an explicit numeric admin override.
 *    Nothing is enforced for unlimited companies.
 */
function voiceBalances(org) {
  const limit = limitsFor(org).voiceMinutesIncluded;
  const override = org?.limitOverrides?.voiceMinutesIncluded;
  const numericOverride = typeof override === "number" && Number.isFinite(override);
  const unlimited = limit === null || limit === undefined || (org?.plan === "enterprise" && !numericOverride);
  const planIncluded = unlimited ? 0 : Math.max(0, Number(limit) || 0);
  const now = Date.now();
  const packPurchased = (org?.addonGrants || [])
    .filter((g) => g?.key === "voiceMinute" && (!g.expiresAt || new Date(g.expiresAt).getTime() > now))
    .reduce((sum, g) => sum + (Number(g.quantity) || 0), 0);
  const packUsed = Math.max(0, Number(org?.voicePrepaidUsed) || 0);
  const used = Number(usageFor(org).voiceMinutes) || 0;
  return {
    unlimited,
    planIncluded,
    used,
    planRemaining: Math.max(0, planIncluded - used),
    packPurchased,
    packUsed,
    packBalance: Math.max(0, packPurchased - packUsed),
  };
}

/**
 * Calling minutes this month. Existing keys are kept for older screens;
 * overage no longer exists (calls stop when the minutes are finished), so
 * overageMinutes is always 0.
 */
function voiceUsage(org) {
  if (!org) return null;
  const b = voiceBalances(org);
  return {
    enabled: hasFeature(org, "aiCalling"),
    unlimited: b.unlimited,
    includedMinutes: b.planIncluded,
    prepaidMinutes: b.packPurchased,
    usedMinutes: b.used,
    // null = unlimited (check `unlimited` first; never compare null with 0).
    remainingIncluded: b.unlimited ? null : b.planRemaining + b.packBalance,
    overageMinutes: 0,
    planRemaining: b.planRemaining,
    packBalance: b.packBalance,
    packPurchased: b.packPurchased,
  };
}

/** Minutes the company can still call (Infinity when unlimited / no tenant). */
function voiceMinutesLeft(org) {
  const u = voiceUsage(org);
  if (!u || u.unlimited) return Infinity;
  return u.remainingIncluded;
}

/** true when the plan has AI calling but every minute (plan + recharged) is used. */
function voiceMinutesExhausted(org) {
  const u = voiceUsage(org);
  return Boolean(u && u.enabled && !u.unlimited && u.remainingIncluded <= 0);
}

/** AI calling can actually place a call: feature on, not switched off by the client, AND minutes left. Legacy (no org) = true. */
function voiceCallingAvailable(org) {
  if (!org) return true;
  if (org.voice?.paused) return false;
  const u = voiceUsage(org);
  return Boolean(u.enabled && (u.unlimited || u.remainingIncluded > 0));
}

function voicePausedError() {
  const ApiError = require("../../utils/ApiError");
  return new ApiError(403, "AI calling is switched off. Turn it on in AI calling → Controls.", { code: "VOICE_PAUSED" });
}

const VOICE_EXHAUSTED_MESSAGE = "AI calling minutes finished. Recharge to continue.";
function voiceExhaustedError() {
  const ApiError = require("../../utils/ApiError");
  return new ApiError(403, VOICE_EXHAUSTED_MESSAGE, { code: "VOICE_MINUTES_EXHAUSTED" });
}

/**
 * How a call of `billed` minutes is paid: first from what is left of the
 * monthly plan allowance, then from recharged packs (capped at the pack
 * balance). `before` = the company BEFORE this call was added to the month.
 */
function splitVoiceMinutes(before, billed) {
  const b = voiceBalances(before);
  const n = Math.max(0, Math.floor(Number(billed) || 0));
  if (b.unlimited) return { fromPlan: n, fromPack: 0, packPurchased: b.packPurchased, packUsed: b.packUsed, unlimited: true };
  const fromPlan = Math.min(n, b.planRemaining);
  const fromPack = Math.min(n - fromPlan, b.packBalance);
  return { fromPlan, fromPack, packPurchased: b.packPurchased, packUsed: b.packUsed, unlimited: false };
}

module.exports.hasFeature = hasFeature;
module.exports.assertFeature = assertFeature;
module.exports.requireFeature = requireFeature;
module.exports.featureError = featureError;
module.exports.voiceUsage = voiceUsage;
module.exports.limitMessage = limitMessage;
module.exports.voiceMinutesLeft = voiceMinutesLeft;
module.exports.voiceMinutesExhausted = voiceMinutesExhausted;
module.exports.voiceCallingAvailable = voiceCallingAvailable;
module.exports.voiceExhaustedError = voiceExhaustedError;
module.exports.voicePausedError = voicePausedError;
module.exports.splitVoiceMinutes = splitVoiceMinutes;
module.exports.VOICE_EXHAUSTED_MESSAGE = VOICE_EXHAUSTED_MESSAGE;
