/**
 * Regional price books. The customer's country (chosen at signup) decides the
 * currency they see and pay in. INR prices come from config/plans.js; other
 * currencies use the table below (override any of it without a deploy with
 * PRICE_BOOK_JSON, e.g. {"AED":{"growth":{"monthly":449}}}).
 *
 * Tax: 18% GST for INR only. Exports of services are zero-rated by default;
 * set TAX_RATE_<CUR> (e.g. TAX_RATE_AED=0.05) if you must charge local tax.
 */
const { PLANS, ADDONS, GST_RATE } = require("./plans");

const COUNTRY_CURRENCY = {
  IN: "INR",
  AE: "AED",
  SA: "SAR",
  QA: "QAR",
  OM: "OMR",
  KW: "KWD",
  BH: "BHD",
  GB: "GBP",
  US: "USD",
  CA: "CAD",
  AU: "AUD",
  SG: "SGD",
  NZ: "NZD",
  DE: "EUR", FR: "EUR", IT: "EUR", ES: "EUR", NL: "EUR", IE: "EUR", BE: "EUR", PT: "EUR", AT: "EUR", FI: "EUR", GR: "EUR",
};

const COUNTRIES = [
  ["IN", "India"], ["AE", "United Arab Emirates"], ["SA", "Saudi Arabia"], ["QA", "Qatar"], ["OM", "Oman"], ["KW", "Kuwait"], ["BH", "Bahrain"],
  ["GB", "United Kingdom"], ["US", "United States"], ["CA", "Canada"], ["AU", "Australia"], ["SG", "Singapore"], ["NZ", "New Zealand"],
  ["DE", "Germany"], ["FR", "France"], ["IT", "Italy"], ["ES", "Spain"], ["NL", "Netherlands"], ["IE", "Ireland"],
  ["NP", "Nepal"], ["BD", "Bangladesh"], ["LK", "Sri Lanka"], ["OTHER", "Other country"],
];

// Monthly price, setup fee and add-on prices per currency (annual = 10 × monthly).
const BOOK = {
  USD: { starter: [59, 69], growth: [119, 139], builder: [249, 299], enterprise: [499, 699], addons: { extraUser: 9, extraNumber: 19, extraAiConversations: 10, voiceMinute: 0.12, leadRevival: 129 } },
  AED: { starter: [219, 249], growth: [439, 499], builder: [899, 1099], enterprise: [1799, 2499], addons: { extraUser: 35, extraNumber: 69, extraAiConversations: 39, voiceMinute: 0.45, leadRevival: 479 } },
  SAR: { starter: [219, 259], growth: [449, 519], builder: [929, 1129], enterprise: [1849, 2599], addons: { extraUser: 35, extraNumber: 72, extraAiConversations: 39, voiceMinute: 0.45, leadRevival: 489 } },
  QAR: { starter: [219, 249], growth: [439, 499], builder: [899, 1099], enterprise: [1799, 2499], addons: { extraUser: 35, extraNumber: 69, extraAiConversations: 39, voiceMinute: 0.45, leadRevival: 479 } },
  OMR: { starter: [23, 27], growth: [46, 54], builder: [96, 115], enterprise: [192, 269], addons: { extraUser: 4, extraNumber: 8, extraAiConversations: 4, voiceMinute: 0.05, leadRevival: 49 } },
  KWD: { starter: [18, 21], growth: [37, 43], builder: [77, 92], enterprise: [154, 215], addons: { extraUser: 3, extraNumber: 6, extraAiConversations: 3, voiceMinute: 0.04, leadRevival: 39 } },
  BHD: { starter: [23, 26], growth: [45, 53], builder: [94, 113], enterprise: [189, 263], addons: { extraUser: 4, extraNumber: 8, extraAiConversations: 4, voiceMinute: 0.05, leadRevival: 49 } },
  GBP: { starter: [49, 59], growth: [99, 119], builder: [199, 249], enterprise: [399, 599], addons: { extraUser: 8, extraNumber: 15, extraAiConversations: 8, voiceMinute: 0.1, leadRevival: 99 } },
  EUR: { starter: [55, 65], growth: [109, 129], builder: [229, 279], enterprise: [459, 649], addons: { extraUser: 9, extraNumber: 17, extraAiConversations: 9, voiceMinute: 0.11, leadRevival: 119 } },
  CAD: { starter: [79, 95], growth: [159, 189], builder: [329, 399], enterprise: [659, 949], addons: { extraUser: 12, extraNumber: 25, extraAiConversations: 13, voiceMinute: 0.16, leadRevival: 169 } },
  AUD: { starter: [89, 105], growth: [179, 209], builder: [369, 449], enterprise: [739, 1049], addons: { extraUser: 14, extraNumber: 29, extraAiConversations: 15, voiceMinute: 0.18, leadRevival: 189 } },
  SGD: { starter: [79, 95], growth: [159, 185], builder: [329, 399], enterprise: [659, 939], addons: { extraUser: 12, extraNumber: 25, extraAiConversations: 13, voiceMinute: 0.16, leadRevival: 169 } },
  NZD: { starter: [99, 115], growth: [199, 235], builder: [409, 499], enterprise: [819, 1159], addons: { extraUser: 15, extraNumber: 32, extraAiConversations: 16, voiceMinute: 0.2, leadRevival: 209 } },
};

let override = {};
try {
  override = process.env.PRICE_BOOK_JSON ? JSON.parse(process.env.PRICE_BOOK_JSON) : {};
} catch {
  override = {};
}

// Razorpay amounts are in the smallest unit: 100 for most currencies, 1000 for 3-decimal Gulf currencies.
const MINOR_UNIT = { KWD: 1000, BHD: 1000, OMR: 1000 };

function currencyForCountry(country) {
  return COUNTRY_CURRENCY[String(country || "").toUpperCase()] || (String(country || "").toUpperCase() === "IN" ? "INR" : "USD");
}

function supported(currency) {
  return currency === "INR" || Boolean(BOOK[currency]);
}

function taxRate(currency) {
  if (currency === "INR") return GST_RATE;
  const env = Number(process.env[`TAX_RATE_${currency}`]);
  return Number.isFinite(env) && env >= 0 && env < 1 ? env : 0;
}

/** { monthly, annual, setupFee } for a plan in a currency. */
function planPrice(planCode, currency = "INR") {
  const plan = PLANS[planCode] || PLANS.trial;
  if (currency === "INR" || !supported(currency)) {
    return { monthly: plan.monthly, annual: plan.annual, setupFee: plan.setupFee || 0, currency: "INR" };
  }
  const row = BOOK[currency][planCode];
  const o = override?.[currency]?.[planCode] || {};
  if (!row) return { monthly: 0, annual: 0, setupFee: 0, currency };
  const monthly = Number(o.monthly ?? row[0]);
  return { monthly, annual: Number(o.annual ?? monthly * 10), setupFee: Number(o.setupFee ?? row[1]), currency };
}

function addonPrice(key, currency = "INR") {
  if (currency === "INR" || !supported(currency)) return ADDONS[key]?.price ?? null;
  return Number(override?.[currency]?.addons?.[key] ?? BOOK[currency].addons?.[key] ?? null);
}

function withTax(amount, currency) {
  const v = amount * (1 + taxRate(currency));
  return currency === "INR" ? Math.round(v) : Math.round(v * 100) / 100;
}

function toMinor(amount, currency) {
  return Math.round(Number(amount) * (MINOR_UNIT[currency] || 100));
}

/** Public plans with prices in the requested currency (for Pricing / Billing pages). */
function plansIn(currency, publicPlans) {
  const cur = supported(currency) ? currency : "INR";
  return publicPlans.map((p) => {
    const price = planPrice(p.code, cur);
    return { ...p, monthly: price.monthly, annual: price.annual, setupFee: price.setupFee, currency: price.currency };
  });
}

function addonsIn(currency) {
  const cur = supported(currency) ? currency : "INR";
  return Object.fromEntries(Object.entries(ADDONS).map(([k, a]) => [k, { ...a, price: addonPrice(k, cur), currency: cur }]));
}

module.exports = {
  COUNTRIES,
  COUNTRY_CURRENCY,
  currencyForCountry,
  supported,
  taxRate,
  planPrice,
  addonPrice,
  withTax,
  toMinor,
  plansIn,
  addonsIn,
  MINOR_UNIT,
};
