/**
 * PropAI / Visitsly SaaS plans — limits, features and copy.
 *
 * MONEY IS NOT HERE. Every price (plans, add-ons, tax) comes from
 * config/pricing.js, which reads PRICE_* environment variables. There is no
 * setup fee.
 *
 * Razorpay plan ids are NOT hard-coded: create the plans once in the
 * Razorpay dashboard (or let checkout create them) and put the ids in env as
 * RAZORPAY_PLAN_<CODE>_<CYCLE>[_<CUR>], e.g. RAZORPAY_PLAN_GROWTH_MONTHLY.
 *
 * `null` limit = unlimited.
 *
 * Limits can be changed from .env without touching code:
 *   <PLAN>_MAX_USERS, <PLAN>_MAX_CONTACTS, <PLAN>_MAX_AI_CONVERSATIONS,
 *   <PLAN>_MAX_WHATSAPP_NUMBERS, <PLAN>_MAX_CAMPAIGNS,
 *   <PLAN>_MAX_BULK_MESSAGES, <PLAN>_AI_REPLIES_PER_CONTACT,
 *   <PLAN>_VOICE_MINUTES_INCLUDED
 * where <PLAN> = TRIAL | STARTER | GROWTH | BUILDER | ENTERPRISE.
 * A number sets the limit; "unlimited" (or "none") removes it; empty/missing
 * keeps the built-in default below.
 */
function envLimit(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const v = String(raw).trim().toLowerCase();
  if (["unlimited", "none", "null", "infinite", "-1"].includes(v)) return null;
  const n = Number.parseInt(v, 10);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function planLimits(code, d) {
  const P = String(code).toUpperCase();
  return {
    users: envLimit(`${P}_MAX_USERS`, d.users),
    contacts: envLimit(`${P}_MAX_CONTACTS`, d.contacts),
    aiConversations: envLimit(`${P}_MAX_AI_CONVERSATIONS`, d.aiConversations),
    whatsappNumbers: envLimit(`${P}_MAX_WHATSAPP_NUMBERS`, d.whatsappNumbers),
    campaignsPerMonth: envLimit(`${P}_MAX_CAMPAIGNS`, d.campaignsPerMonth),
    // Bulk (campaign) messages, WhatsApp + email together. Trial: total for the
    // whole trial. Paid plans: per calendar month.
    bulkMessages: envLimit(`${P}_MAX_BULK_MESSAGES`, d.bulkMessages),
    // How many replies the AI sends to ONE contact before it stops (null = no cap).
    aiRepliesPerContact: envLimit(
      `${P}_AI_REPLIES_PER_CONTACT`,
      d.aiRepliesPerContact,
    ),
    // AI calling minutes included each month. When they (plus any recharged
    // minutes) are finished, calls STOP until the company recharges (the
    // voiceMinute add-on). Only meaningful when the plan has `aiCalling`.
    voiceMinutesIncluded: envLimit(
      `${P}_VOICE_MINUTES_INCLUDED`,
      d.voiceMinutesIncluded,
    ),
  };
}

const inNum = (v) => Number(v).toLocaleString("en-IN");

/**
 * Feature flags. Every flag listed here is enforced server-side through
 * services/saas/subscription.js (hasFeature / assertFeature / requireFeature),
 * except the ones marked "info only" (sales / service promises, no code path).
 */
const FEATURE_KEYS = [
  "aiAgent", // AI WhatsApp agent (core, every plan)
  "leadScoring", // core
  "siteVisitBooking", // core
  "leadAlerts", // core
  "bulkWhatsapp", // WhatsApp campaigns
  "emailCampaigns", // email setup, email templates, email campaigns
  "teamRouting", // team lead assignment / round-robin routing
  "autoFollowUps", // follow-ups sent automatically (else: reminders only)
  "inventory", // inventory management: property import / export / bulk delete
  "multiProjectBot", // project sites + brochures the bot answers from
  "metaLeadAds", // Meta (Facebook / Instagram) Lead Ads sync
  "weeklyReports", // weekly WhatsApp report to the owner
  "aiCalling", // AI voice calling (never on the free trial)
  "metaBilling", // Meta bill dashboard
  "portalIntegrations", // info only (Enterprise)
  "customWorkflows", // info only (Enterprise)
  "dedicatedManager", // info only (Enterprise)
];

const FEATURE_LABEL = {
  aiAgent: "AI WhatsApp Agent",
  leadScoring: "Lead Scoring",
  siteVisitBooking: "Automatic Site Visit Booking",
  leadAlerts: "Lead Alerts",
  bulkWhatsapp: "Bulk WhatsApp campaigns",
  emailCampaigns: "Email campaigns",
  teamRouting: "Team Lead Assignment",
  autoFollowUps: "Automatic Follow-ups",
  inventory: "Inventory Management",
  multiProjectBot: "Multi-Project Bot",
  metaLeadAds: "Meta Lead Ads Sync",
  weeklyReports: "Weekly Reports",
  aiCalling: "AI calling",
  metaBilling: "Meta bill dashboard",
  portalIntegrations: "Portal Integrations",
  customWorkflows: "Custom Workflows",
  dedicatedManager: "Dedicated Account Manager",
};

function features(on) {
  return Object.fromEntries(FEATURE_KEYS.map((k) => [k, on.includes(k)]));
}

const CORE = ["aiAgent", "leadScoring", "siteVisitBooking", "leadAlerts"];
// Starter gets the full WhatsApp automation (bulk WhatsApp campaigns, bulk
// "start conversations", automatic follow-ups); only its limits are smaller.
// Starter has NO AI calling (Growth and above only).
const STARTER_F = [...CORE, "bulkWhatsapp", "autoFollowUps"];
// AI calling starts at Growth (monthly included minutes + recharge packs).
const GROWTH_F = [...STARTER_F, "aiCalling", "emailCampaigns", "teamRouting", "metaBilling"];
const BUILDER_F = [...GROWTH_F, "inventory", "multiProjectBot", "metaLeadAds", "weeklyReports"];
const ENTERPRISE_F = [...FEATURE_KEYS];
// Free trial: try the product end to end, except email and AI calling.
const TRIAL_F = FEATURE_KEYS.filter(
  (k) => !["emailCampaigns", "aiCalling", "portalIntegrations", "customWorkflows", "dedicatedManager"].includes(k),
);

const TRIAL_LIMITS = planLimits("trial", {
  users: 1,
  contacts: 50,
  aiConversations: 50,
  whatsappNumbers: 1,
  campaignsPerMonth: 1,
  bulkMessages: 50,
  aiRepliesPerContact: 15,
  voiceMinutesIncluded: 0,
});

function trialHighlights(l) {
  const n = (v, unlimited, text) => (v == null ? unlimited : text(inNum(v)));
  return [
    "AI WhatsApp Agent, lead scoring, site visit booking",
    n(l.contacts, "Unlimited contacts", (v) => `Upload up to ${v} contacts`),
    n(l.bulkMessages, "Bulk WhatsApp messages", (v) => `${v} bulk WhatsApp messages`),
    n(l.aiConversations, "Unlimited AI conversations", (v) => `${v} AI conversations`),
    n(l.aiRepliesPerContact, "AI chatting", (v) => `Up to ${v} AI replies per contact`),
    n(l.campaignsPerMonth, "Unlimited campaigns", (v) => `${v} WhatsApp campaign${l.campaignsPerMonth === 1 ? "" : "s"}`),
    n(l.users, "Unlimited logins", (v) => `${v} login${l.users === 1 ? "" : "s"}`),
    "Email campaigns and AI calling on paid plans",
  ];
}

function limitLine(v, unit, unlimited) {
  return v == null ? unlimited : `${inNum(v)} ${unit}`;
}

const STARTER_LIMITS = planLimits("starter", {
  users: 1,
  contacts: 5000,
  aiConversations: 1000,
  whatsappNumbers: 1,
  campaignsPerMonth: 30,
  bulkMessages: null,
  aiRepliesPerContact: null,
  voiceMinutesIncluded: 0,
});
const GROWTH_LIMITS = planLimits("growth", {
  users: 5,
  contacts: 15000,
  aiConversations: 3000,
  whatsappNumbers: 1,
  campaignsPerMonth: null,
  bulkMessages: null,
  aiRepliesPerContact: null,
  voiceMinutesIncluded: 30,
});
const BUILDER_LIMITS = planLimits("builder", {
  users: 10,
  contacts: 50000,
  aiConversations: 10000,
  whatsappNumbers: 2,
  campaignsPerMonth: null,
  bulkMessages: null,
  aiRepliesPerContact: null,
  voiceMinutesIncluded: 100,
});
const ENTERPRISE_LIMITS = planLimits("enterprise", {
  users: null,
  contacts: null,
  aiConversations: null,
  whatsappNumbers: null,
  campaignsPerMonth: null,
  bulkMessages: null,
  aiRepliesPerContact: null,
  // Custom: set per company by the platform admin (limitOverrides.voiceMinutesIncluded).
  voiceMinutesIncluded: 0,
});

const logins = (l) => limitLine(l.users, l.users === 1 ? "login" : "logins", "Unlimited logins");
const chats = (l) => limitLine(l.aiConversations, "AI chats / month", "Custom AI chat volume");

const PLANS = {
  trial: {
    code: "trial",
    name: "Free trial",
    public: false,
    limits: TRIAL_LIMITS,
    features: features(TRIAL_F),
    highlights: trialHighlights(TRIAL_LIMITS),
  },
  starter: {
    code: "starter",
    name: "Starter",
    tagline: "For brokers",
    public: true,
    businessType: "broker",
    limits: STARTER_LIMITS,
    features: features(STARTER_F),
    highlights: [
      logins(STARTER_LIMITS),
      chats(STARTER_LIMITS),
      "AI WhatsApp Agent",
      "Bulk WhatsApp campaigns",
      "Automatic Follow-ups",
      "Lead Scoring",
      "Automatic Site Visit Booking",
      "Lead Alerts",
    ],
  },
  growth: {
    code: "growth",
    name: "Growth",
    tagline: "For agencies",
    public: true,
    popular: true,
    businessType: "agency",
    limits: GROWTH_LIMITS,
    features: features(GROWTH_F),
    highlights: [
      logins(GROWTH_LIMITS),
      chats(GROWTH_LIMITS),
      "Everything in Starter",
      "Email campaigns",
      "Team Lead Assignment",
      "Meta bill dashboard",
    ],
  },
  builder: {
    code: "builder",
    name: "Builder Pro",
    tagline: "For builders & developers",
    public: true,
    businessType: "builder",
    limits: BUILDER_LIMITS,
    features: features(BUILDER_F),
    highlights: [
      logins(BUILDER_LIMITS),
      chats(BUILDER_LIMITS),
      "Everything in Growth",
      "Inventory Management",
      "Multi-Project Bot",
      "Meta Lead Ads Sync",
      "Weekly Reports",
    ],
  },
  enterprise: {
    code: "enterprise",
    name: "Enterprise",
    tagline: "Large / multi-city",
    public: true,
    contactSales: true,
    customPricing: true,
    limits: ENTERPRISE_LIMITS,
    features: features(ENTERPRISE_F),
    highlights: [
      "Unlimited logins",
      "Custom AI chat volume",
      "All features",
      "Portal Integrations",
      "Custom Workflows",
      "Dedicated Account Manager",
    ],
  },
};

/** Names and units only — prices live in config/pricing.js (PRICE_<CUR>_ADDON_*). */
const ADDONS = {
  extraUser: { name: "Extra user", unit: "month" },
  extraNumber: { name: "Extra WhatsApp number", unit: "month" },
  extraAiConversations: { name: "1,000 extra AI conversations", unit: "pack" },
  voiceMinute: { name: "AI voice calling", unit: "minute" },
  emailCredit: { name: "Email wallet recharge", unit: "email" },
  leadRevival: { name: "Old leads revival campaign", unit: "once" },
};

/** Business type chosen in onboarding → the plan we recommend. */
const RECOMMENDED_PLAN = { broker: "starter", agency: "growth", builder: "builder" };

const configuredTrialDays = Number.parseInt(process.env.TRIAL_DAYS || "7", 10);
const TRIAL_DAYS =
  Number.isInteger(configuredTrialDays) &&
  configuredTrialDays > 0 &&
  configuredTrialDays <= 90
    ? configuredTrialDays
    : 7;

function getPlan(code) {
  return PLANS[code] || PLANS.trial;
}

/** Plan limits with any per-org overrides applied (set by the platform admin). */
function limitsFor(org) {
  const base = getPlan(org?.plan).limits;
  const overrides = org?.limitOverrides || {};
  const out = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined && value !== "") out[key] = value; // null = unlimited
  }
  // Paid add-ons stack on top of the plan (unlimited stays unlimited).
  const add = org?.addons || {};
  // Add-ons bought in-app (Billing → Add-ons) count while they are active.
  const now = Date.now();
  const granted = { extraUser: 0, extraNumber: 0, extraAiConversations: 0 };
  for (const g of org?.addonGrants || []) {
    if (g?.expiresAt && new Date(g.expiresAt).getTime() < now) continue;
    if (granted[g.key] !== undefined) granted[g.key] += Number(g.quantity) || 0;
  }
  // Extra logins only count on plans that have a team (not Starter / Trial).
  if (out.users != null && ["growth", "builder", "enterprise"].includes(org?.plan)) out.users += (add.extraUsers || 0) + granted.extraUser;
  if (out.whatsappNumbers != null) out.whatsappNumbers += (add.extraNumbers || 0) + granted.extraNumber;
  if (out.aiConversations != null)
    out.aiConversations += ((add.aiPacks || 0) + granted.extraAiConversations) * 1000;
  return out;
}

/**
 * Feature flags for a company: plan features, then per-org overrides
 * (`featureOverrides`, set by the platform admin or the grandfathering
 * migration). Only booleans in the override count.
 */
function featuresFor(org) {
  const out = { ...getPlan(org?.plan).features };
  const overrides = org?.featureOverrides || {};
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === "boolean" && key in out) out[key] = value;
  }
  return out;
}

/** The cheapest public plan that includes a feature (for upgrade messages). */
function cheapestPlanWith(feature) {
  return ["starter", "growth", "builder", "enterprise"].map((c) => PLANS[c]).find((p) => p.features[feature]) || null;
}

/** Plan data without money — pricing.plansIn() adds prices per currency. */
function publicPlans() {
  return Object.values(PLANS)
    .filter((p) => p.public)
    .map(({ code, name, tagline, popular, contactSales, customPricing, businessType, limits, features: f, highlights }) => ({
      code,
      name,
      tagline,
      popular: !!popular,
      contactSales: !!contactSales,
      customPricing: !!customPricing,
      businessType: businessType || null,
      limits,
      features: f,
      highlights,
    }));
}

module.exports = {
  PLANS,
  ADDONS,
  FEATURE_KEYS,
  FEATURE_LABEL,
  RECOMMENDED_PLAN,
  TRIAL_DAYS,
  getPlan,
  limitsFor,
  featuresFor,
  cheapestPlanWith,
  publicPlans,
};
