/**
 * Price book — every amount of money the product shows or charges.
 *
 * All prices come from environment variables, read once at startup (a restart
 * is enough to apply a change; no code deploy). Missing or invalid values fall
 * back to the built-in defaults below and log a warning — never a crash, and
 * never a ₹0 paid plan.
 *
 *   SUPPORTED_CURRENCIES=INR,AED,USD
 *   ANNUAL_MONTHS_CHARGED=10                       annual = monthly × this
 *   PRICE_<CUR>_<PLAN>_MONTHLY                     e.g. PRICE_AED_GROWTH_MONTHLY=499
 *   PRICE_<CUR>_<PLAN>_ANNUAL      (optional)      overrides monthly × months
 *   PRICE_<CUR>_ADDON_<KEY>                        EXTRA_USER, EXTRA_NUMBER, EXTRA_AI_PACK,
 *                                                  VOICE_MINUTE, LEAD_REVIVAL
 *   TAX_RATE_<CUR>                                 0.18 = 18 %
 *   COUNTRY_CURRENCY_JSON          (optional)      {"SA":"USD"} — country → currency map override
 *
 * Country → currency: IN → INR, AE → AED, every other country → USD.
 * Enterprise has no price ("Custom pricing — contact sales"). No setup fee.
 */
const logger = require("../utils/logger");
const { COUNTRY_LIST } = require("./countries");

const PAID_PLANS = ["starter", "growth", "builder"];

const DEFAULTS = {
  INR: {
    plans: { starter: 3999, growth: 7999, builder: 17999 },
    addons: { extraUser: 699, extraNumber: 1499, extraAiConversations: 750, voiceMinute: 7, leadRevival: 9999 },
    tax: 0.18,
  },
  AED: {
    plans: { starter: 249, growth: 499, builder: 999 },
    addons: { extraUser: 35, extraNumber: 69, extraAiConversations: 39, voiceMinute: 0.45, leadRevival: 479 },
    tax: 0,
  },
  USD: {
    plans: { starter: 69, growth: 149, builder: 299 },
    addons: { extraUser: 9, extraNumber: 19, extraAiConversations: 10, voiceMinute: 0.12, leadRevival: 129 },
    tax: 0,
  },
};

// Env names for add-ons (PRICE_<CUR>_ADDON_<NAME>).
const ADDON_ENV = {
  extraUser: "EXTRA_USER",
  extraNumber: "EXTRA_NUMBER",
  extraAiConversations: "EXTRA_AI_PACK",
  voiceMinute: "VOICE_MINUTE",
  leadRevival: "LEAD_REVIVAL",
};

// Razorpay amounts are in the smallest unit: 100 for INR / AED / USD.
const MINOR_UNIT = { INR: 100, AED: 100, USD: 100 };

const warnings = [];
function warn(message) {
  warnings.push(message);
}

function readNumber(name, fallback, { positive = true, max = Infinity } = {}) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const n = Number(String(raw).trim());
  const ok = Number.isFinite(n) && (positive ? n > 0 : n >= 0) && n <= max;
  if (!ok) {
    warn(`${name}="${raw}" is invalid — using ${fallback}`);
    return fallback;
  }
  return n;
}

function buildBook() {
  const requested = String(process.env.SUPPORTED_CURRENCIES || "INR,AED,USD")
    .split(",")
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);
  const currencies = requested.filter((c) => DEFAULTS[c]);
  for (const c of requested) if (!DEFAULTS[c]) warn(`SUPPORTED_CURRENCIES: ${c} is not supported (only INR, AED, USD) — ignored`);
  if (!currencies.includes("INR")) {
    // INR is the settlement currency and the Razorpay fallback; always keep it.
    if (process.env.SUPPORTED_CURRENCIES) warn("SUPPORTED_CURRENCIES must include INR — added it");
    currencies.unshift("INR");
  }

  const months = readNumber("ANNUAL_MONTHS_CHARGED", 10, { max: 12 });

  const book = {};
  for (const cur of currencies) {
    const d = DEFAULTS[cur];
    const plans = {};
    for (const plan of PAID_PLANS) {
      const P = plan.toUpperCase();
      const monthly = readNumber(`PRICE_${cur}_${P}_MONTHLY`, d.plans[plan]);
      const annualDefault = Math.round(monthly * months * 100) / 100;
      const annual = readNumber(`PRICE_${cur}_${P}_ANNUAL`, annualDefault);
      plans[plan] = { monthly, annual };
    }
    const addons = {};
    for (const [key, envName] of Object.entries(ADDON_ENV)) {
      addons[key] = readNumber(`PRICE_${cur}_ADDON_${envName}`, d.addons[key]);
    }
    const tax = readNumber(`TAX_RATE_${cur}`, d.tax, { positive: false, max: 0.99 });
    book[cur] = { plans, addons, tax };
  }

  const countryCurrency = { IN: "INR", AE: "AED" };
  if (process.env.COUNTRY_CURRENCY_JSON) {
    try {
      const parsed = JSON.parse(process.env.COUNTRY_CURRENCY_JSON);
      for (const [country, cur] of Object.entries(parsed || {})) {
        const c = String(cur).toUpperCase();
        if (book[c]) countryCurrency[String(country).toUpperCase()] = c;
        else warn(`COUNTRY_CURRENCY_JSON: ${country} → ${cur} is not a supported currency — ignored`);
      }
    } catch (err) {
      warn(`COUNTRY_CURRENCY_JSON is not valid JSON (${err.message}) — ignored`);
    }
  }
  return { currencies, book, months, countryCurrency };
}

const { currencies: SUPPORTED_CURRENCIES, book: BOOK, months: ANNUAL_MONTHS_CHARGED, countryCurrency: COUNTRY_CURRENCY } = buildBook();

/** Logged once at startup (server.js) so a typo in .env is visible. */
function logPricingWarnings() {
  for (const w of warnings) logger.warn(`[pricing] ${w}`);
  logger.info(
    `[pricing] Currencies ${SUPPORTED_CURRENCIES.join(", ")} · ` +
      SUPPORTED_CURRENCIES.map((c) => `${c} ${PAID_PLANS.map((p) => BOOK[c].plans[p].monthly).join("/")}`).join(" · "),
  );
}

const GST_RATE = BOOK.INR.tax;

function supported(currency) {
  return Boolean(BOOK[String(currency || "").toUpperCase()]);
}

/** IN → INR, AE → AED, every other country → USD (overridable with COUNTRY_CURRENCY_JSON). */
function currencyForCountry(country) {
  const code = String(country || "").toUpperCase();
  const cur = COUNTRY_CURRENCY[code] || "USD";
  if (supported(cur)) return cur;
  return supported("USD") ? "USD" : "INR";
}

function taxRate(currency) {
  return BOOK[currency]?.tax ?? 0;
}

/**
 * { monthly, annual, setupFee: 0, currency } for a plan in a currency.
 * Enterprise / trial → monthly and annual are null (custom pricing / free).
 */
function planPrice(planCode, currency = "INR") {
  const cur = supported(currency) ? currency : "INR";
  const row = BOOK[cur].plans[planCode];
  if (!row) return { monthly: null, annual: null, setupFee: 0, currency: cur, customPricing: planCode === "enterprise" };
  return { monthly: row.monthly, annual: row.annual, setupFee: 0, currency: cur };
}

function addonPrice(key, currency = "INR") {
  const cur = supported(currency) ? currency : "INR";
  const v = BOOK[cur].addons[key];
  return v === undefined ? null : v;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

function withTax(amount, currency) {
  const v = Number(amount || 0) * (1 + taxRate(currency));
  return currency === "INR" ? Math.round(v) : round2(v);
}

function toMinor(amount, currency) {
  return Math.round(Number(amount) * (MINOR_UNIT[currency] || 100));
}

/** Public plans with prices in the requested currency (for Pricing / Billing pages). */
function plansIn(currency, publicPlans) {
  const cur = supported(currency) ? currency : "INR";
  return publicPlans.map((p) => {
    const price = planPrice(p.code, cur);
    return {
      ...p,
      monthly: price.monthly,
      annual: price.annual,
      setupFee: 0, // kept for older clients; there is no setup fee
      currency: cur,
      customPricing: Boolean(p.customPricing || price.monthly == null),
    };
  });
}

function addonsIn(currency) {
  const { ADDONS } = require("./plans");
  const cur = supported(currency) ? currency : "INR";
  return Object.fromEntries(Object.entries(ADDONS).filter(([k]) => k !== "emailCredit").map(([k, a]) => [k, { ...a, price: addonPrice(k, cur), currency: cur }]));
}

/** Full country list for dropdowns: [code, name, currency, dialCode]. */
const COUNTRIES = COUNTRY_LIST.map(([code, name, dial]) => [code, name, currencyForCountry(code), dial]);

module.exports = {
  COUNTRIES,
  COUNTRY_CURRENCY,
  SUPPORTED_CURRENCIES,
  ANNUAL_MONTHS_CHARGED,
  GST_RATE,
  currencyForCountry,
  supported,
  taxRate,
  planPrice,
  addonPrice,
  withTax,
  toMinor,
  plansIn,
  addonsIn,
  logPricingWarnings,
  MINOR_UNIT,
};
