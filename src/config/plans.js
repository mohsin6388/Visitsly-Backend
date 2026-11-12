/**
 * Visitsly (PropAI) SaaS plans — single source of truth for prices, limits
 * and features, for BOTH markets:
 *
 *   region "in"  → India, prices in INR, GST 18% extra
 *   region "ae"  → UAE,   prices in AED, VAT extra (AE_TAX_RATE, default 0 —
 *                          services exported from India are zero-rated; the
 *                          UAE client self-accounts VAT under reverse charge.
 *                          Set AE_TAX_RATE=0.05 if you bill from a UAE entity.)
 *
 * Billing cycles
 *   monthly     → monthly price, one-time setup fee charged
 *   halfyearly  → 6 × monthly, paid up front, SETUP FEE WAIVED
 *   annual      → 10 × monthly (2 months free), SETUP FEE WAIVED
 *
 * Limits can still be changed from .env without touching code:
 *   <PLAN>_MAX_USERS, <PLAN>_MAX_CONTACTS, <PLAN>_MAX_AI_CONVERSATIONS,
 *   <PLAN>_MAX_WHATSAPP_NUMBERS, <PLAN>_MAX_CAMPAIGNS,
 *   <PLAN>_MAX_BULK_MESSAGES, <PLAN>_AI_REPLIES_PER_CONTACT
 * and per region: <PLAN>_<REGION>_MAX_USERS (e.g. STARTER_AE_MAX_USERS=3).
 * A number sets the limit; "unlimited" (or "none") removes it.
 *
 * `null` limit = unlimited.
 */

const REGIONS = {
  in: {
    code: "in",
    name: "India",
    currency: "INR",
    symbol: "₹",
    locale: "en-IN",
    timezone: "Asia/Kolkata",
    taxLabel: "GST",
    taxRate: 0.18,
  },
  ae: {
    code: "ae",
    name: "UAE",
    currency: "AED",
    symbol: "AED ",
    locale: "en-AE",
    timezone: "Asia/Dubai",
    taxLabel: process.env.AE_TAX_LABEL || "VAT",
    taxRate: (() => {
      const r = Number.parseFloat(process.env.AE_TAX_RATE || "0");
      return Number.isFinite(r) && r >= 0 && r < 1 ? r : 0;
    })(),
  },
};

const CYCLES = {
  monthly: { code: "monthly", months: 1, multiplier: 1, waivesSetup: false, label: "Monthly" },
  halfyearly: { code: "halfyearly", months: 6, multiplier: 6, waivesSetup: true, label: "6 months" },
  annual: { code: "annual", months: 12, multiplier: 10, waivesSetup: true, label: "Yearly (2 months free)" },
};

// Back-compat: GST_RATE is still exported for older callers (India only).
const GST_RATE = REGIONS.in.taxRate;

function envLimit(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const v = String(raw).trim().toLowerCase();
  if (["unlimited", "none", "null", "infinite", "-1"].includes(v)) return null;
  const n = Number.parseInt(v, 10);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

const LIMIT_KEYS = {
  users: "MAX_USERS",
  contacts: "MAX_CONTACTS",
  aiConversations: "MAX_AI_CONVERSATIONS",
  whatsappNumbers: "MAX_WHATSAPP_NUMBERS",
  campaignsPerMonth: "MAX_CAMPAIGNS",
  // Bulk (campaign) messages, WhatsApp + email together. Trial: total for the
  // whole trial. Paid plans: per calendar month.
  bulkMessages: "MAX_BULK_MESSAGES",
  // How many replies the AI sends to ONE contact before it stops (null = no cap).
  aiRepliesPerContact: "AI_REPLIES_PER_CONTACT",
};

/** Limits for one plan in one region: defaults → region defaults → env → region env. */
function planLimits(code, defaults, regionDefaults = {}) {
  const P = String(code).toUpperCase();
  const out = {};
  for (const region of Object.keys(REGIONS)) {
    const R = region.toUpperCase();
    const merged = { ...defaults, ...(regionDefaults[region] || {}) };
    const limits = {};
    for (const [key, suffix] of Object.entries(LIMIT_KEYS)) {
      const base = envLimit(`${P}_${suffix}`, merged[key] === undefined ? null : merged[key]);
      limits[key] = envLimit(`${P}_${R}_${suffix}`, base);
    }
    out[region] = limits;
  }
  return out;
}

const num = (v, locale = "en-IN") => Number(v).toLocaleString(locale);

/* ------------------------------------------------------------------ */
/* Features                                                            */
/* ------------------------------------------------------------------ */

/**
 * Feature flags per plan. Each plan includes everything of the plan before it.
 *   Core (every plan): aiAgent, leadScoring, visitBooking, leadAlerts
 *   Growth+:           bulkWhatsapp, emailCampaigns, leadAssignment, followUps, metaBilling
 *   Builder Pro+:      inventory, multiProject, metaLeadAds, weeklyReports
 *   Enterprise:        portalIntegrations, customWorkflows, whiteLabel, dedicatedManager
 */
const CORE = { aiAgent: true, leadScoring: true, visitBooking: true, leadAlerts: true };
const GROWTH = { ...CORE, bulkWhatsapp: true, emailCampaigns: true, leadAssignment: true, followUps: true, metaBilling: true };
const BUILDER = { ...GROWTH, inventory: true, multiProject: true, metaLeadAds: true, weeklyReports: true };
const ENTERPRISE = { ...BUILDER, portalIntegrations: true, customWorkflows: true, whiteLabel: true, dedicatedManager: true };

const FEATURE_LABELS = {
  aiAgent: "AI WhatsApp agent",
  leadScoring: "Lead scoring",
  visitBooking: "Automatic visit booking",
  leadAlerts: "Lead alerts",
  bulkWhatsapp: "Bulk WhatsApp campaigns",
  emailCampaigns: "Bulk email campaigns",
  leadAssignment: "Lead assignment to team",
  followUps: "Automatic follow-ups",
  inventory: "Inventory management",
  multiProject: "Multi-project bot",
  metaLeadAds: "Meta lead ads sync",
  weeklyReports: "Weekly reports",
  metaBilling: "Meta billing dashboard",
  portalIntegrations: "Portal integrations",
  customWorkflows: "Custom workflows",
  whiteLabel: "White-label",
  dedicatedManager: "Dedicated manager",
};

/** Lowest public plan that includes a feature (used in "upgrade to …" messages). */
const FEATURE_MIN_PLAN = {
  bulkWhatsapp: "growth",
  emailCampaigns: "growth",
  leadAssignment: "growth",
  followUps: "growth",
  inventory: "builder",
  multiProject: "builder",
  metaLeadAds: "builder",
  weeklyReports: "builder",
  metaBilling: "growth",
  portalIntegrations: "enterprise",
  customWorkflows: "enterprise",
  whiteLabel: "enterprise",
  dedicatedManager: "enterprise",
};

/* ------------------------------------------------------------------ */
/* Plans                                                               */
/* ------------------------------------------------------------------ */

const TRIAL_LIMITS = planLimits("trial", {
  users: 2,
  contacts: 500,
  aiConversations: 100,
  whatsappNumbers: 1,
  campaignsPerMonth: 5,
  bulkMessages: 100,
  aiRepliesPerContact: 15,
});

function trialHighlights(l) {
  return [
    "CRM, leads, properties aur conversations",
    l.contacts == null ? "Unlimited leads / contacts" : `${num(l.contacts)} leads / contacts tak`,
    l.bulkMessages == null ? "Bulk WhatsApp / email messages" : `${num(l.bulkMessages)} bulk messages (WhatsApp / email)`,
    l.aiRepliesPerContact == null ? "AI chatting" : `AI har contact ko ${num(l.aiRepliesPerContact)} replies tak karega`,
    l.aiConversations == null ? "Unlimited AI conversations" : `${num(l.aiConversations)} AI conversations`,
    "1 WhatsApp number connect karein",
    l.campaignsPerMonth == null ? "Unlimited campaigns" : `${num(l.campaignsPerMonth)} WhatsApp/email campaigns`,
    l.users == null ? "Unlimited team members" : `Maximum ${num(l.users)} team members`,
  ];
}

/**
 * `pricing[region]` = { monthly, setupFee } in that region's currency.
 * Missing region = plan not sold there. `contactSales` = shown as "from"
 * price, bought through the sales team, not online checkout.
 */
const PLANS = {
  trial: {
    code: "trial",
    name: "Free trial",
    public: false,
    pricing: { in: { monthly: 0, setupFee: 0 }, ae: { monthly: 0, setupFee: 0 } },
    limits: TRIAL_LIMITS,
    // Trial can try everything, inside small limits.
    features: { ...BUILDER },
    highlights: { in: trialHighlights(TRIAL_LIMITS.in), ae: trialHighlights(TRIAL_LIMITS.ae) },
  },
  solo: {
    code: "solo",
    name: "Solo",
    tagline: "Independent agent",
    public: true,
    regions: ["ae"],
    pricing: { ae: { monthly: 249, setupFee: 0 } },
    limits: planLimits("solo", {
      users: 1,
      contacts: 2000,
      aiConversations: 500,
      whatsappNumbers: 1,
      campaignsPerMonth: 0,
      bulkMessages: 0,
      aiRepliesPerContact: null,
    }),
    features: { ...CORE },
    highlights: {
      ae: ["1 login", "500 AI chats / month", "Lead scoring", "Viewing booking", "Lead alerts", "No setup fee"],
    },
  },
  starter: {
    code: "starter",
    name: "Starter",
    tagline: "Brokers & small teams",
    public: true,
    pricing: { in: { monthly: 3999, setupFee: 5000 }, ae: { monthly: 499, setupFee: 500 } },
    limits: planLimits(
      "starter",
      {
        users: 1,
        contacts: 5000,
        aiConversations: 1000,
        whatsappNumbers: 1,
        campaignsPerMonth: 0,
        bulkMessages: 0,
        aiRepliesPerContact: null,
      },
      { ae: { users: 3 } },
    ),
    features: { ...CORE },
    highlights: {
      in: ["1 login", "1,000 AI chats / month", "Lead scoring", "Visit booking", "Lead alerts"],
      ae: ["3 logins", "1,000 AI chats / month", "Lead scoring", "Auto-chat bot", "Viewing booking", "Alert system"],
    },
  },
  growth: {
    code: "growth",
    name: "Growth",
    tagline: "Agencies & teams",
    public: true,
    popular: true,
    pricing: { in: { monthly: 7999, setupFee: 10000 }, ae: { monthly: 999, setupFee: 2400 } },
    limits: planLimits("growth", {
      users: 5,
      contacts: 15000,
      aiConversations: 3000,
      whatsappNumbers: 1,
      campaignsPerMonth: null,
      bulkMessages: null,
      aiRepliesPerContact: null,
    }),
    features: { ...GROWTH },
    highlights: {
      in: ["5 logins", "3,000 AI chats / month", "Bulk WhatsApp + Email", "Lead assignment", "Follow-ups"],
      ae: ["5 logins", "3,000 AI chats / month", "Bulk WhatsApp + Email", "Lead assignment", "Follow-ups"],
    },
  },
  builder: {
    // Code stays "builder" so existing companies keep their plan.
    code: "builder",
    name: "Builder Pro",
    tagline: "Builders & developers",
    public: true,
    pricing: { in: { monthly: 14999, setupFee: 25000 }, ae: { monthly: 1999, setupFee: 5000 } },
    limits: planLimits("builder", {
      users: 10,
      contacts: 50000,
      aiConversations: 10000,
      whatsappNumbers: 2,
      campaignsPerMonth: null,
      bulkMessages: null,
      aiRepliesPerContact: null,
    }),
    features: { ...BUILDER },
    highlights: {
      in: ["10 logins", "10,000 AI chats / month", "Inventory management", "Multi-project bot", "Meta lead ads sync", "Weekly reports"],
      ae: ["10 logins", "10,000 AI chats / month", "Inventory management", "Multi-project bot", "Meta lead ads sync", "Weekly reports"],
    },
  },
  enterprise: {
    code: "enterprise",
    name: "Enterprise",
    tagline: "Large builders & CP networks",
    public: true,
    contactSales: true,
    pricing: { in: { monthly: 30000, setupFee: 50000 }, ae: { monthly: 3999, setupFee: 10000 } },
    limits: planLimits("enterprise", {
      users: null,
      contacts: null,
      aiConversations: null,
      whatsappNumbers: null,
      campaignsPerMonth: null,
      bulkMessages: null,
      aiRepliesPerContact: null,
    }),
    features: { ...ENTERPRISE },
    highlights: {
      in: ["Unlimited logins", "Portal integrations", "Custom workflows", "Dedicated manager"],
      ae: ["Unlimited logins", "Portal integrations", "Custom workflows", "Dedicated manager"],
    },
  },
};

// Back-compat fields (INR) used by older code paths and the platform panel.
for (const plan of Object.values(PLANS)) {
  const inr = plan.pricing.in || { monthly: 0, setupFee: 0 };
  plan.monthly = inr.monthly;
  plan.annual = inr.monthly * CYCLES.annual.multiplier;
  plan.setupFee = inr.setupFee;
}

/** Add-ons, priced per region (null = on request in that region). */
const ADDONS = {
  voiceMinute: { name: "AI calling", unit: "minute", price: { in: 8, ae: 8 }, display: { in: "₹7–8 per minute", ae: "AED 7–8 per minute" } },
  extraUser: { name: "Extra login", unit: "month", price: { in: 999, ae: 99 } },
  extraAiConversations: { name: "Extra 1,000 AI chats", unit: "pack", price: { in: 1000, ae: 100 } },
  metaAdsManagement: { name: "Meta Ads management", unit: "month", price: { in: 15000, ae: 1500 }, note: "+ ad spend" },
  projectLaunch: {
    name: "Project Launch Package",
    unit: "once",
    price: { in: 74999, ae: 7499 },
    note: "3 months: setup + Builder Pro + ads",
  },
  extraNumber: { name: "Extra WhatsApp number", unit: "month", price: { in: 1499, ae: null } },
};

const configuredTrialDays = Number.parseInt(process.env.TRIAL_DAYS || "7", 10);
const TRIAL_DAYS =
  Number.isInteger(configuredTrialDays) && configuredTrialDays > 0 && configuredTrialDays <= 90 ? configuredTrialDays : 7;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function regionOf(orgOrRegion) {
  const r = typeof orgOrRegion === "string" ? orgOrRegion : orgOrRegion?.region;
  return r === "ae" ? "ae" : "in";
}

function getRegion(orgOrRegion) {
  return REGIONS[regionOf(orgOrRegion)];
}

function getCycle(code) {
  return CYCLES[code] || CYCLES.monthly;
}

function getPlan(code) {
  return PLANS[code] || PLANS.trial;
}

function isSoldIn(planCode, region) {
  const plan = PLANS[planCode];
  if (!plan) return false;
  return Boolean(plan.pricing[regionOf(region)]) && (!plan.regions || plan.regions.includes(regionOf(region)));
}

/** { monthly, setupFee, periodPrice, setupDue, currency } for a plan/region/cycle (before tax). */
function priceFor(planCode, region, cycleCode = "monthly") {
  const plan = getPlan(planCode);
  const reg = getRegion(region);
  const cycle = getCycle(cycleCode);
  const p = plan.pricing[reg.code] || { monthly: 0, setupFee: 0 };
  return {
    currency: reg.currency,
    monthly: p.monthly,
    setupFee: p.setupFee,
    cycle: cycle.code,
    months: cycle.months,
    periodPrice: p.monthly * cycle.multiplier,
    setupDue: cycle.waivesSetup ? 0 : p.setupFee,
    setupWaived: cycle.waivesSetup && p.setupFee > 0,
  };
}

/** Plan limits with region, per-org overrides and paid add-ons applied. */
function limitsFor(org) {
  const plan = getPlan(org?.plan);
  const base = plan.limits[regionOf(org)] || plan.limits.in;
  const overrides = org?.limitOverrides || {};
  const out = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined && value !== "") out[key] = value; // null = unlimited
  }
  const add = org?.addons || {};
  if (out.users != null) out.users += add.extraUsers || 0;
  if (out.whatsappNumbers != null) out.whatsappNumbers += add.extraNumbers || 0;
  if (out.aiConversations != null) out.aiConversations += (add.aiPacks || 0) * 1000;
  return out;
}

/**
 * Feature flags for an org: plan features + per-org overrides set by the
 * platform admin (`featureOverrides`, e.g. { bulkWhatsapp: true } to keep
 * bulk messaging for a Starter client who bought it before the new plans).
 */
function featuresFor(org) {
  const base = { ...getPlan(org?.plan).features };
  const overrides = org?.featureOverrides || {};
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === "boolean") base[key] = value;
  }
  return base;
}

function hasFeature(org, key) {
  if (!org) return true; // legacy single-client mode
  return Boolean(featuresFor(org)[key]);
}

function upgradeMessageFor(featureKey, org) {
  const planCode = FEATURE_MIN_PLAN[featureKey] || "growth";
  const label = FEATURE_LABELS[featureKey] || featureKey;
  return `${label} ${getPlan(org?.plan).name} plan mein included nahi hai. ${getPlan(planCode).name} ya upar ka plan lein.`;
}

function publicPlans(region = "in") {
  const reg = getRegion(region);
  return Object.values(PLANS)
    .filter((p) => p.public && isSoldIn(p.code, reg.code))
    .map((p) => {
      const price = priceFor(p.code, reg.code, "monthly");
      return {
        code: p.code,
        name: p.name,
        tagline: p.tagline,
        popular: !!p.popular,
        contactSales: !!p.contactSales,
        currency: reg.currency,
        monthly: price.monthly,
        halfyearly: price.monthly * CYCLES.halfyearly.multiplier,
        annual: price.monthly * CYCLES.annual.multiplier,
        setupFee: price.setupFee,
        limits: p.limits[reg.code],
        features: p.features,
        highlights: p.highlights[reg.code] || p.highlights.in || [],
      };
    });
}

function publicAddons(region = "in") {
  const reg = getRegion(region);
  return Object.entries(ADDONS).map(([code, a]) => ({
    code,
    name: a.name,
    unit: a.unit,
    note: a.note || null,
    currency: reg.currency,
    price: a.price[reg.code],
    display: a.display?.[reg.code] || null,
  }));
}

module.exports = {
  REGIONS,
  CYCLES,
  PLANS,
  ADDONS,
  GST_RATE,
  TRIAL_DAYS,
  FEATURE_LABELS,
  FEATURE_MIN_PLAN,
  regionOf,
  getRegion,
  getCycle,
  getPlan,
  isSoldIn,
  priceFor,
  limitsFor,
  featuresFor,
  hasFeature,
  upgradeMessageFor,
  publicPlans,
  publicAddons,
};
