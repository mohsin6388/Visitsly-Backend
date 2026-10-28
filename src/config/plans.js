/**
 * PropAI SaaS plans — single source of truth for prices and limits.
 * Prices are in INR, GST (18%) extra. Annual billing = 10 months' price.
 *
 * Razorpay plan ids are NOT hard-coded: create the plans once in the
 * Razorpay dashboard (or let `npm run razorpay:plans` create them) and put
 * the ids in env as RAZORPAY_PLAN_<CODE>_<CYCLE>, e.g. RAZORPAY_PLAN_GROWTH_MONTHLY.
 *
 * `null` limit = unlimited.
 */
const PLANS = {
  trial: {
    code: 'trial',
    name: 'Free trial',
    public: false,
    monthly: 0,
    annual: 0,
    setupFee: 0,
    limits: { users: 2, contacts: 500, aiConversations: 100, whatsappNumbers: 1, campaignsPerMonth: 5 },
    features: { metaBilling: true, emailCampaigns: true, bulkWhatsapp: true },
    highlights: [
      'CRM, leads, properties aur conversations',
      '500 leads / contacts tak',
      '100 AI conversations',
      '1 WhatsApp number connect karein',
      '5 WhatsApp/email campaigns',
      'Maximum 2 team members',
    ],
  },
  starter: {
    code: 'starter',
    name: 'Starter',
    tagline: 'Akela broker',
    public: true,
    monthly: 3999,
    annual: 39990,
    setupFee: 4999,
    limits: { users: 3, contacts: 5000, aiConversations: 1500, whatsappNumbers: 1, campaignsPerMonth: 30 },
    features: { metaBilling: false, emailCampaigns: true, bulkWhatsapp: true },
    highlights: [
      '3 users, 1 WhatsApp number',
      '5,000 contacts',
      '1,500 AI conversations / month',
      'Bulk WhatsApp + email',
      'Qualified leads, site visits, follow-ups',
    ],
  },
  growth: {
    code: 'growth',
    name: 'Growth',
    tagline: 'Broker team / agency',
    public: true,
    popular: true,
    monthly: 7999,
    annual: 79990,
    setupFee: 9999,
    limits: { users: 8, contacts: 15000, aiConversations: 4000, whatsappNumbers: 1, campaignsPerMonth: null },
    features: { metaBilling: true, emailCampaigns: true, bulkWhatsapp: true },
    highlights: [
      '8 users',
      '15,000 contacts',
      '4,000 AI conversations / month',
      'Meta billing dashboard',
      'Unlimited campaigns',
      'Sites & brochures',
    ],
  },
  builder: {
    code: 'builder',
    name: 'Builder',
    tagline: 'Builder / developer',
    public: true,
    monthly: 17999,
    annual: 179990,
    setupFee: 24999,
    limits: { users: 20, contacts: 50000, aiConversations: 10000, whatsappNumbers: 2, campaignsPerMonth: null },
    features: { metaBilling: true, emailCampaigns: true, bulkWhatsapp: true },
    highlights: [
      '20 users, 2 WhatsApp numbers',
      '50,000 contacts',
      '10,000 AI conversations / month',
      'Inventory in Excel mode',
      'Priority support',
    ],
  },
  enterprise: {
    code: 'enterprise',
    name: 'Enterprise',
    tagline: 'Multi-city builder',
    public: true,
    contactSales: true,
    monthly: 35000,
    annual: 350000,
    setupFee: 50000,
    limits: { users: null, contacts: null, aiConversations: null, whatsappNumbers: null, campaignsPerMonth: null },
    features: { metaBilling: true, emailCampaigns: true, bulkWhatsapp: true },
    highlights: [
      'Unlimited users and contacts',
      'Multiple WhatsApp numbers',
      'White-label on your domain',
      'Custom integrations',
      'Dedicated account manager',
    ],
  },
};

const ADDONS = {
  extraUser: { name: 'Extra user', price: 699, unit: 'month' },
  extraNumber: { name: 'Extra WhatsApp number', price: 1499, unit: 'month' },
  extraAiConversations: { name: '1,000 extra AI conversations', price: 750, unit: 'pack' },
  voiceMinute: { name: 'AI voice calling', price: 7, unit: 'minute' },
  leadRevival: { name: 'Purani leads revive campaign', price: 9999, unit: 'once' },
};

const GST_RATE = 0.18;
const configuredTrialDays = Number.parseInt(process.env.TRIAL_DAYS || '7', 10);
const TRIAL_DAYS = Number.isInteger(configuredTrialDays) && configuredTrialDays > 0 && configuredTrialDays <= 90
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
    if (value !== undefined && value !== '') out[key] = value; // null = unlimited
  }
  // Paid add-ons stack on top of the plan (unlimited stays unlimited).
  const add = org?.addons || {};
  if (out.users != null) out.users += add.extraUsers || 0;
  if (out.whatsappNumbers != null) out.whatsappNumbers += add.extraNumbers || 0;
  if (out.aiConversations != null) out.aiConversations += (add.aiPacks || 0) * 1000;
  return out;
}

function publicPlans() {
  return Object.values(PLANS)
    .filter((p) => p.public)
    .map(({ code, name, tagline, popular, contactSales, monthly, annual, setupFee, limits, highlights }) => ({
      code, name, tagline, popular: !!popular, contactSales: !!contactSales,
      monthly, annual, setupFee, limits, highlights,
    }));
}

module.exports = { PLANS, ADDONS, GST_RATE, TRIAL_DAYS, getPlan, limitsFor, publicPlans };
