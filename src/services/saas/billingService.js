const crypto = require('crypto');
const axios = require('axios');
const env = require('../../config/env');
const Organization = require('../../models/Organization');
const Invoice = require('../../models/Invoice');
const RazorpayPlan = require('../../models/RazorpayPlan');
const OutboundJob = require('../../models/OutboundJob');
const ApiError = require('../../utils/ApiError');
const logger = require('../../utils/logger');
const orgService = require('./orgService');
const { getPlan, ADDONS } = require('../../config/plans');
const pricing = require('../../config/pricing');
const invoiceService = require('../billing/invoiceService');
const pricingService = require('../billing/pricingService');

const { GST_RATE } = pricing;

/**
 * Razorpay Subscriptions billing for PropAI.
 *
 * Flow: Billing page → POST /billing/checkout → Razorpay Checkout popup
 * (card / UPI AutoPay / netbanking e-mandate) → POST /billing/verify →
 * company becomes `active`. Renewals, failures and cancellations arrive on
 * POST /api/webhooks/razorpay and keep the company status in sync.
 *
 * Without Razorpay keys the platform admin can still activate companies and
 * record offline payments (UPI / bank transfer) from the Platform panel.
 */
const rzp = axios.create({ baseURL: 'https://api.razorpay.com/v1', timeout: 20000 });

function configured() {
  return Boolean(env.razorpay.keyId && env.razorpay.keySecret);
}

function auth() {
  return { username: env.razorpay.keyId, password: env.razorpay.keySecret };
}

function rzpFail(err, fallback) {
  const e = err.response?.data?.error;
  logger.error('[billing] Razorpay API error', { error: e || err.message });
  return ApiError.badRequest(e?.description || err.message || fallback, { code: 'RAZORPAY_ERROR' });
}

/**
 * An invoice just became paid: number + tax breakup + buyer snapshot, then the
 * invoice e-mail in the background. Can never throw or change the payment.
 */
async function invoicePaid(invoiceId) {
  try {
    await invoiceService.onInvoicePaid(invoiceId);
  } catch (err) {
    logger.warn('[billing] invoice step failed (payment is unaffected)', { invoice: String(invoiceId), error: err.message });
  }
}

/** The currency this company is billed in (from its signup country). */
function currencyOf(org) {
  const cur = String(org?.currency || '').toUpperCase();
  if (pricing.supported(cur)) return cur;
  // Older companies may still carry a retired currency (SAR, GBP, EUR …):
  // bill them in their country's currency (IN → INR, AE → AED, else USD).
  return pricing.currencyForCountry(org?.country || 'IN');
}

/** Monthly / annual price (before tax) for this org, honouring a custom INR price. */
function priceFor(org, planCode, cycle, currency = currencyOf(org)) {
  if (currency === 'INR' && org?.priceOverride && planCode === org.plan) {
    return cycle === 'annual' ? org.priceOverride * pricing.ANNUAL_MONTHS_CHARGED : org.priceOverride;
  }
  const p = pricing.planPrice(planCode, currency);
  return cycle === 'annual' ? p.annual : p.monthly;
}

/**
 * Price quote for one plan/cycle. `extras` = { offer, coupon } (already looked up,
 * see quoteFor) so this stays synchronous. Maths, all before tax:
 *   price (list, or offer price, or the company's custom price)
 *   − coupon discount  = subtotal   →   + tax = total (what Razorpay charges and the invoice shows).
 */
function quote(org, planCode, cycle, currencyOverride, extras = {}) {
  const plan = getPlan(planCode);
  const currency = currencyOverride || currencyOf(org);
  let base = priceFor(org, planCode, cycle, currency);
  const customPrice = currency === 'INR' && org?.priceOverride && planCode === org.plan;
  const offer = !customPrice && extras.offer ? extras.offer : null;
  if (offer) base = offer.offerPrice;
  const coupon = extras.coupon || null;
  const couponDiscount = pricingService.couponDiscount(coupon, base, currency);
  const subtotal = Math.round((base - couponDiscount) * 100) / 100;
  const taxRate = pricing.taxRate(currency);
  const priceWithTax = pricing.withTax(subtotal, currency);
  if (coupon && !(priceWithTax > 0)) {
    throw ApiError.badRequest('This coupon cannot be used on this plan because it would make the total zero.', { code: 'COUPON_INVALID' });
  }
  return {
    plan: plan.code,
    planName: plan.name,
    cycle,
    currency,
    price: base,
    // Offer ("was ₹X, now ₹Y"): null when no offer applies.
    listPrice: offer ? offer.listPrice : base,
    offer: offer ? { listPrice: offer.listPrice, offerPrice: offer.offerPrice, percentOff: offer.percentOff, label: offer.label || '' } : null,
    coupon: coupon ? { code: coupon.code, type: coupon.type, value: coupon.value, appliesTo: coupon.appliesTo || 'first' } : null,
    couponDiscount,
    subtotal,
    taxAmount: Math.round((priceWithTax - subtotal) * 100) / 100,
    total: priceWithTax,
    priceWithTax,
    // No setup fee any more; the fields stay (always 0) for older clients.
    setupFee: 0,
    setupFeeWithTax: 0,
    taxRate,
    taxLabel: currency === 'INR' ? 'GST' : taxRate ? 'Tax' : null,
    firstPayment: priceWithTax,
    // Back-compat field names used by older clients.
    priceWithGst: priceWithTax,
    setupFeeWithGst: 0,
    gstRate: currency === 'INR' ? GST_RATE : 0,
  };
}

/**
 * Quote with the live offer and (optionally) a coupon, validated server-side.
 * → { quote, coupon }. Throws ApiError(400, {code:'COUPON_*'}) for a bad coupon.
 */
async function quoteFor(org, planCode, cycle, { couponCode, currencyOverride } = {}) {
  const currency = currencyOverride || currencyOf(org);
  const offers = await pricingService.activeOffers(currency);
  const offer = pricingService.offerFor(offers, planCode, cycle, currency);
  const coupon = couponCode ? await pricingService.validateCoupon(couponCode, { orgId: org?._id, plan: planCode, cycle, currency }) : null;
  return { quote: quote(org, planCode, cycle, currency, { offer, coupon }), coupon };
}

/**
 * One active paid plan at a time: while a paid plan is running (status active,
 * period not over) the company can't buy a DIFFERENT plan/cycle, and a
 * self-renewing subscription can't be bought a second time. Renewing the same
 * plan (order mode) keeps working. Platform admins change plans via /api/platform.
 */
function assertPlanChangeAllowed(org, planCode, cycle) {
  if (!org || org.status !== 'active') return;
  const live = !org.currentPeriodEnd || new Date(org.currentPeriodEnd) > new Date();
  if (!live) return;
  const same = org.plan === planCode && org.billingCycle === cycle;
  const autoRenews = org.razorpay?.mode === 'subscription' && org.razorpay?.subscriptionId && !org.cancelAtPeriodEnd;
  if (!same) {
    throw ApiError.badRequest(
      'You already have an active plan. You can choose a new plan after the current one ends. Contact support if you need to change it now.',
      { code: 'PLAN_ALREADY_ACTIVE' },
    );
  }
  if (autoRenews) {
    throw ApiError.badRequest('Your plan is active and renews automatically.', { code: 'PLAN_ALREADY_ACTIVE' });
  }
}

async function ensurePlanId(planCode, cycle, amount, currency = 'INR') {
  const envKey = `RAZORPAY_PLAN_${planCode.toUpperCase()}_${cycle.toUpperCase()}${currency === 'INR' ? '' : `_${currency}`}`;
  const amountMinor = pricing.toMinor(pricing.withTax(amount, currency), currency);
  const standardPrice = pricing.planPrice(planCode, currency);
  const standard = cycle === 'annual' ? standardPrice.annual : standardPrice.monthly;
  if (process.env[envKey] && amount === standard) return process.env[envKey];

  const existing = await RazorpayPlan.findOne({ code: planCode, cycle, amountPaise: amountMinor, currency }).lean();
  if (existing) return existing.planId;

  try {
    const { data } = await rzp.post(
      '/plans',
      {
        period: cycle === 'annual' ? 'yearly' : 'monthly',
        interval: 1,
        item: {
          name: `${env.saas.productName} ${getPlan(planCode).name} (${cycle})`,
          amount: amountMinor,
          currency,
          description: currency === 'INR' ? `Incl. ${Math.round(GST_RATE * 100)}% GST` : `${currency} plan`,
        },
        notes: { code: planCode, cycle, currency },
      },
      { auth: auth() }
    );
    await RazorpayPlan.create({ code: planCode, cycle, amountPaise: amountMinor, currency, planId: data.id });
    logger.info(`[billing] Created Razorpay plan ${data.id} for ${planCode}/${cycle}/${currency} — set ${envKey}=${data.id} to pin it`);
    return data.id;
  } catch (err) {
    const desc = String(err.response?.data?.error?.description || '');
    if (currency !== 'INR' && /currency/i.test(desc)) {
      const e = new Error('CURRENCY_NOT_ENABLED');
      e.code = 'CURRENCY_NOT_ENABLED';
      throw e;
    }
    throw rzpFail(err, 'Razorpay plan create failed');
  }
}

async function createCheckout(orgId, { plan: planCode, cycle = 'monthly', coupon: couponCode }, user) {
  const plan = getPlan(planCode);
  if (!plan.public || plan.code === 'trial') throw ApiError.badRequest('This plan can’t be bought online');
  if (plan.contactSales) throw ApiError.badRequest('Contact sales for Enterprise');
  if (!configured()) {
    throw ApiError.badRequest('Online payment is not set up yet. Pay via UPI/bank transfer and our team will activate it.', { code: 'BILLING_NOT_CONFIGURED' });
  }

  const org = await Organization.findById(orgId).lean();
  assertPlanChangeAllowed(org, plan.code, cycle);
  const prefill = { name: user?.name || '', email: org.billingEmail || user?.email || '', contact: org.phone || '' };
  // The offer and coupon are re-checked here on the server; the client amount is never trusted.
  let { quote: q, coupon } = await quoteFor(org, plan.code, cycle, { couponCode });
  // A "first payment only" coupon can't be applied to just the first charge of a Razorpay
  // subscription cleanly, so that first period is a one-time order (renew from the Billing page).
  const firstPaymentOnly = Boolean(coupon) && coupon.appliesTo !== 'all';
  if (paymentMode() === 'order' || firstPaymentOnly) return createPlanOrder(orgId, org, plan, cycle, prefill, { couponCode });

  let planId;
  let currencyNote = null;
  let sub;
  try {
    try {
      planId = await ensurePlanId(plan.code, cycle, q.subtotal, q.currency);
    } catch (err) {
      if (err.code !== 'CURRENCY_NOT_ENABLED') throw err;
      // International payments not enabled on the Razorpay account yet → bill in INR.
      logger.warn(
        `[billing] FALLBACK TO INR: ${q.currency} checkout for org ${orgId} (${plan.code}/${cycle}) is being charged in INR because ` +
          'International Payments / this currency is not enabled on the Razorpay account. Enable it in Razorpay Dashboard → Account & Settings → International payments.',
      );
      currencyNote = `${q.currency} payments are not available yet, so you will be charged in INR.`;
      ({ quote: q, coupon } = await quoteFor(org, plan.code, cycle, { couponCode, currencyOverride: 'INR' }));
      planId = await ensurePlanId(plan.code, cycle, q.subtotal, 'INR');
    }
    const body = {
      plan_id: planId,
      total_count: cycle === 'annual' ? 10 : 120,
      quantity: 1,
      customer_notify: 1,
      notes: { orgId: String(orgId), plan: plan.code, cycle, currency: q.currency, ...(coupon ? { coupon: coupon.code } : {}) },
    };
    ({ data: sub } = await rzp.post('/subscriptions', body, { auth: auth() }));
  } catch (err) {
    // Auth problems must surface; anything else (Subscriptions not enabled on
    // the account, plan API errors …) falls back to a one-time payment for
    // the period, so the customer can still pay and upgrade.
    if (err.response?.status === 401) throw rzpFail(err, 'Razorpay keys are invalid');
    if (String(err.details?.code || '').startsWith('COUPON_')) throw err;
    logger.warn('[billing] Subscription checkout failed — using a one-time payment for this period instead', {
      orgId: String(orgId),
      error: err.response?.data?.error?.description || err.message,
    });
    return createPlanOrder(orgId, org, plan, cycle, prefill, { couponCode });
  }

  await Organization.updateOne(
    { _id: orgId },
    { $set: { pendingPlan: plan.code, pendingCycle: cycle, pendingCheckout: { quote: q, couponId: coupon?._id || null }, 'razorpay.pendingSubscriptionId': sub.id, 'razorpay.planId': planId } }
  );
  orgService.invalidate(orgId);

  return {
    mode: 'subscription',
    keyId: env.razorpay.keyId,
    subscriptionId: sub.id,
    quote: q,
    currencyNote,
    prefill,
    productName: env.saas.productName,
  };
}

/**
 * RAZORPAY_PAYMENT_MODE=subscription (default): auto-renewing Razorpay
 * subscription, falling back to a one-time payment if subscriptions fail.
 * RAZORPAY_PAYMENT_MODE=order: always a one-time payment per period (the
 * customer renews from the Billing page).
 */
function paymentMode() {
  return String(process.env.RAZORPAY_PAYMENT_MODE || 'subscription').trim().toLowerCase() === 'order' ? 'order' : 'subscription';
}

/** Tax breakup + offer/coupon details stored on the invoice so it matches the charged amount exactly. */
function pricingFields(q, coupon) {
  return {
    taxRate: q.taxRate,
    subtotal: q.subtotal,
    taxAmount: q.taxAmount,
    ...(q.offer || coupon
      ? {
          pricing: {
            listSubtotal: q.listPrice,
            offerDiscount: q.offer ? Math.round((q.listPrice - q.price) * 100) / 100 : 0,
            couponCode: coupon?.code,
            couponId: coupon?._id,
            couponDiscount: q.couponDiscount,
          },
        }
      : {}),
  };
}

/** Counts the coupon use of a PAID invoice (idempotent). */
async function redeemCouponOf(orgId, invoice, ref) {
  const used = invoice?.pricing;
  if (!used?.couponId) return;
  await pricingService.recordRedemption({
    couponId: used.couponId,
    code: used.couponCode,
    orgId,
    invoiceId: invoice._id,
    ref: ref || invoice.razorpayOrderId || String(invoice._id),
    plan: invoice.plan,
    cycle: invoice.billingCycle,
    amountOff: used.couponDiscount || 0,
    currency: invoice.currency,
  });
}

/** One-time Razorpay order for one plan period (monthly / annual). */
async function createPlanOrder(orgId, org, plan, cycle, prefill, { couponCode } = {}) {
  assertPlanChangeAllowed(org, plan.code, cycle);
  let { quote: q, coupon } = await quoteFor(org, plan.code, cycle, { couponCode });
  let currencyNote = null;
  const create = (qq) => rzp.post('/orders', {
    amount: pricing.toMinor(qq.priceWithTax, qq.currency),
    currency: qq.currency,
    receipt: `plan_${String(orgId).slice(-8)}_${Date.now()}`,
    notes: { orgId: String(orgId), plan: plan.code, cycle, kind: 'plan', ...(coupon ? { coupon: coupon.code } : {}) },
  }, { auth: auth() });
  let order;
  try {
    ({ data: order } = await create(q));
  } catch (err) {
    const desc = String(err.response?.data?.error?.description || '');
    if (q.currency === 'INR' || !/currency/i.test(desc)) throw rzpFail(err, 'Razorpay order create failed');
    logger.warn(`[billing] FALLBACK TO INR: ${q.currency} plan payment for org ${orgId} is being charged in INR because International Payments / this currency is not enabled on the Razorpay account.`);
    currencyNote = `${q.currency} payments are not available yet, so you will be charged in INR.`;
    ({ quote: q, coupon } = await quoteFor(org, plan.code, cycle, { couponCode, currencyOverride: 'INR' }));
    ({ data: order } = await create(q).catch((e) => { throw rzpFail(e, 'Razorpay order create failed'); }));
  }
  await Invoice.create({
    orgId,
    kind: 'plan',
    status: 'pending',
    plan: plan.code,
    billingCycle: cycle,
    amount: q.priceWithTax,
    currency: q.currency,
    description: `${q.planName} (${cycle === 'annual' ? 'yearly' : 'monthly'})${coupon ? ` — coupon ${coupon.code}` : ''}`,
    razorpayOrderId: order.id,
    paidAt: null,
    ...pricingFields(q, coupon),
  });
  await Organization.updateOne({ _id: orgId }, { $set: { pendingPlan: plan.code, pendingCycle: cycle } });
  orgService.invalidate(orgId);
  return {
    mode: 'order',
    keyId: env.razorpay.keyId,
    orderId: order.id,
    amount: order.amount,
    currency: order.currency,
    quote: q,
    currencyNote,
    prefill,
    productName: env.saas.productName,
  };
}

/** Activates a paid plan order (idempotent: webhook + browser may both report it). */
async function applyPlanOrder(orgId, invoice, paymentId) {
  const claimed = await Invoice.findOneAndUpdate(
    { _id: invoice._id, status: 'pending' },
    { $set: { status: 'paid', razorpayPaymentId: paymentId, paidAt: new Date() } },
    { new: true },
  );
  if (!claimed) return false;
  const org = await Organization.findById(orgId).lean();
  const cycle = invoice.billingCycle === 'annual' ? 'annual' : 'monthly';
  // Renewing the same plan early extends from the current period end.
  const from = org?.status === 'active' && org.plan === invoice.plan && org.currentPeriodEnd && new Date(org.currentPeriodEnd) > new Date()
    ? new Date(org.currentPeriodEnd)
    : new Date();
  const periodEnd = periodEndFrom(cycle, from);
  await activate(orgId, { plan: invoice.plan, cycle, periodEnd });
  await Organization.updateOne({ _id: orgId }, { $set: { 'razorpay.mode': 'order' } });
  await Invoice.updateOne({ _id: invoice._id }, { $set: { periodStart: from, periodEnd } });
  orgService.invalidate(orgId);
  await redeemCouponOf(orgId, invoice, invoice.razorpayOrderId); // counted only now, after the payment
  await invoicePaid(invoice._id); // invoice number + PDF e-mail (first successful claim only)
  return true;
}

async function verifyPlanOrder(orgId, { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature }) {
  if (!verifyOrderSignature(orderId, paymentId, signature)) throw ApiError.badRequest('Payment could not be verified. If money was deducted, the plan activates within 5–10 minutes; otherwise contact support.');
  const invoice = await Invoice.findOne({ orgId, razorpayOrderId: orderId, kind: 'plan' });
  if (!invoice) throw ApiError.badRequest('This payment does not match this account’s checkout');
  await applyPlanOrder(orgId, invoice, paymentId);
  return Invoice.findById(invoice._id).lean();
}

/* ------------------------------------------------------------------ */
/* Add-ons bought in-app (one-time Razorpay order)                     */
/* ------------------------------------------------------------------ */
const ADDON_RULES = {
  extraUser: { months: 1, min: 1, max: 50, unitLabel: 'user' },
  extraNumber: { months: 1, min: 1, max: 10, unitLabel: 'number' },
  extraAiConversations: { months: 1, min: 1, max: 50, unitLabel: 'pack' },
  voiceMinute: { months: null, min: 100, max: 50000, unitLabel: 'minute' },
  leadRevival: { months: null, min: 1, max: 1, unitLabel: 'campaign' },
  // Per-email wallet recharge: quantity = number of emails. Price comes from EMAIL_COST/MARGIN_PER_EMAIL (INR only).
  emailCredit: { months: null, min: 1000, max: 500000, unitLabel: 'email' },
};

function addonQuote(org, key, quantity) {
  const rule = ADDON_RULES[key];
  if (!rule || !ADDONS[key]) throw ApiError.badRequest('This add-on is not available');
  // AI calling minutes can only be recharged on plans that include AI calling (Growth and above).
  if (key === 'voiceMinute' && org && !require('./subscription').hasFeature(org, 'aiCalling')) {
    const need = require('../../config/plans').cheapestPlanWith('aiCalling');
    throw new ApiError(403, `AI calling is available on ${need?.name || 'Growth'} and above`, {
      code: 'PLAN_LIMIT',
      key: 'feature:aiCalling',
      feature: 'aiCalling',
      requiredPlan: need?.code || null,
    });
  }
  // Starter and Trial have no team, so extra logins can't be bought there.
  if (key === 'extraUser' && org && !require('./permissions').teamAvailable(org)) {
    throw new ApiError(403, 'Team members are available on Growth and above', { code: 'PLAN_LIMIT', key: 'team', requiredPlan: 'growth' });
  }
  // Email wallet: only on plans with email campaigns; always billed in INR (+GST) from the wallet price.
  if (key === 'emailCredit' && org && !require('./subscription').hasFeature(org, 'emailCampaigns')) {
    const need = require('../../config/plans').cheapestPlanWith('emailCampaigns');
    throw new ApiError(403, `Email campaigns are available on ${need?.name || 'Growth'} and above`, { code: 'PLAN_LIMIT', key: 'feature:emailCampaigns', feature: 'emailCampaigns', requiredPlan: need?.code || null });
  }
  const qty = Math.min(Math.max(Math.round(Number(quantity) || rule.min), rule.min), rule.max);
  const currency = key === 'emailCredit' ? 'INR' : currencyOf(org);
  const unit = key === 'emailCredit' ? require('../email/emailWallet').pricing().unitMilli / 1000 : pricing.addonPrice(key, currency);
  const amount = Math.round(unit * qty * 100) / 100;
  return { key, name: ADDONS[key].name, quantity: qty, unitPrice: unit, currency, amount, total: pricing.withTax(amount, currency), taxRate: pricing.taxRate(currency), months: rule.months };
}

async function createAddonOrder(orgId, { addon, quantity }, user) {
  if (!configured()) throw ApiError.badRequest('Online payment is not set up yet. Ask our team to activate the add-on.', { code: 'BILLING_NOT_CONFIGURED' });
  const org = await Organization.findById(orgId).lean();
  let q = addonQuote(org, addon, quantity);
  let order;
  const create = (qq) => rzp.post('/orders', {
    amount: pricing.toMinor(qq.total, qq.currency),
    currency: qq.currency,
    receipt: `addon_${String(orgId).slice(-8)}_${Date.now()}`,
    notes: { orgId: String(orgId), addon: qq.key, quantity: String(qq.quantity) },
  }, { auth: auth() });
  try {
    ({ data: order } = await create(q));
  } catch (err) {
    const desc = String(err.response?.data?.error?.description || '');
    if (q.currency !== 'INR' && /currency/i.test(desc)) {
      logger.warn(
        `[billing] FALLBACK TO INR: ${q.currency} add-on order (${addon}) for org ${orgId} is being charged in INR because ` +
          'International Payments / this currency is not enabled on the Razorpay account.',
      );
      q = addonQuote({ ...org, currency: 'INR' }, addon, quantity);
      ({ data: order } = await create(q).catch((e) => { throw rzpFail(e, 'Order create failed'); }));
    } else throw rzpFail(err, 'Order create failed');
  }
  await Invoice.create({
    orgId,
    kind: 'addon',
    status: 'pending',
    amount: q.total,
    currency: q.currency,
    description: `${q.name} × ${q.quantity}`,
    addon: { key: q.key, quantity: q.quantity },
    razorpayOrderId: order.id,
    paidAt: null,
  });
  return {
    keyId: env.razorpay.keyId,
    orderId: order.id,
    amount: order.amount,
    currency: order.currency,
    quote: q,
    prefill: { name: user?.name || '', email: org.billingEmail || user?.email || '', contact: org.phone || '' },
    productName: env.saas.productName,
  };
}

function verifyOrderSignature(orderId, paymentId, signature) {
  if (!env.razorpay.keySecret) return false;
  const expected = crypto.createHmac('sha256', env.razorpay.keySecret).update(`${orderId}|${paymentId}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Applies a paid add-on (idempotent per order). */
async function grantAddon(orgId, invoice, paymentId) {
  const claimed = await Invoice.findOneAndUpdate(
    { _id: invoice._id, status: 'pending' },
    { $set: { status: 'paid', razorpayPaymentId: paymentId, paidAt: new Date() } },
    { new: true },
  );
  if (!claimed) return false; // already applied (webhook + client both report success)
  const key = invoice.addon?.key;
  const qty = invoice.addon?.quantity || 1;
  const rule = ADDON_RULES[key] || {};
  const expiresAt = rule.months ? new Date(Date.now() + rule.months * 31 * 86400000) : null;
  if (key === 'emailCredit') {
    // Email wallet: credit N emails (idempotent per invoice) and resume jobs paused for an empty wallet.
    await require('../email/emailWallet').creditRecharge(orgId, invoice._id, qty);
  } else {
    await Organization.updateOne({ _id: orgId }, { $push: { addonGrants: { key, quantity: qty, expiresAt, paymentId } } });
  }
  if (key === 'leadRevival') {
    try {
      const PlatformRequest = require('../../models/PlatformRequest');
      await PlatformRequest.create({ orgId, type: 'addon', addon: key, quantity: qty, message: 'Paid in-app — set up the lead revival campaign', status: 'open' });
    } catch (err) {
      logger.warn('[billing] could not create lead revival request', { error: err.message });
    }
  }
  orgService.invalidate(orgId);
  await invoicePaid(invoice._id); // invoice number + PDF e-mail (first successful claim only)
  return true;
}

async function verifyAddonPayment(orgId, { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature }) {
  if (!verifyOrderSignature(orderId, paymentId, signature)) throw ApiError.badRequest('Payment could not be verified. If money was deducted, it updates within 5–10 minutes; otherwise contact support.');
  const invoice = await Invoice.findOne({ orgId, razorpayOrderId: orderId });
  if (!invoice) throw ApiError.badRequest('This payment does not match this account’s order');
  await grantAddon(orgId, invoice, paymentId);
  return Invoice.findById(invoice._id).lean();
}

function verifySignature(paymentId, subscriptionId, signature) {
  if (!env.razorpay.keySecret) return false;
  const expected = crypto.createHmac('sha256', env.razorpay.keySecret).update(`${paymentId}|${subscriptionId}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function periodEndFrom(cycle, fromDate = new Date()) {
  const d = new Date(fromDate);
  if (cycle === 'annual') d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  return d;
}

/** Marks the org paid + active on plan/cycle and resumes jobs paused by the lapse. */
async function activate(orgId, { plan, cycle, subscriptionId, periodEnd, setupFeePaid }) {
  const org = await Organization.findById(orgId);
  if (!org) return null;
  const oldSub = org.razorpay?.subscriptionId;

  // Never fall back to pendingPlan here: a stale pending plan must not activate a plan.
  // Callers pass the plan of the payment they verified.
  org.plan = plan || org.plan;
  org.billingCycle = cycle || org.billingCycle;
  org.status = 'active';
  org.currentPeriodEnd = periodEnd || periodEndFrom(org.billingCycle);
  org.cancelAtPeriodEnd = false;
  org.suspendedReason = null;
  if (subscriptionId) {
    org.razorpay.mode = 'subscription';
    org.razorpay.subscriptionId = subscriptionId;
    if (org.razorpay.pendingSubscriptionId === subscriptionId) org.razorpay.pendingSubscriptionId = null;
  }
  if (setupFeePaid) org.razorpay.setupFeePaid = true;
  org.pendingPlan = null;
  org.pendingCycle = null;
  org.pendingCheckout = null;
  await org.save();
  orgService.invalidate(orgId);

  // Upgrade/downgrade via a new subscription: stop billing the old one.
  if (oldSub && subscriptionId && oldSub !== subscriptionId && configured()) {
    rzp.post(`/subscriptions/${oldSub}/cancel`, { cancel_at_cycle_end: 0 }, { auth: auth() }).catch((err) =>
      logger.warn('[billing] Could not cancel previous subscription', { oldSub, error: err.response?.data?.error || err.message })
    );
  }

  await OutboundJob.updateMany(
    { ownerId: org.ownerUserId, status: 'paused', lastError: 'Subscription inactive' },
    { $set: { status: 'pending', lastError: null, nextRunAt: new Date() } }
  ).catch(() => {});
  return org;
}

async function recordInvoice(orgId, data) {
  if (data.razorpayPaymentId) {
    const exists = await Invoice.findOne({ razorpayPaymentId: data.razorpayPaymentId }).lean();
    if (exists) return exists;
  }
  const created = await Invoice.create({ orgId, ...data });
  // A NEW paid row (subscription charge, offline payment): number it and e-mail it.
  // A duplicate found above returns early, so nothing is sent twice.
  if (created.status === 'paid') await invoicePaid(created._id);
  return created;
}

async function verifyCheckout(orgId, { razorpay_payment_id: paymentId, razorpay_subscription_id: subscriptionId, razorpay_signature: signature }) {
  if (!verifySignature(paymentId, subscriptionId, signature)) throw ApiError.badRequest('Payment signature could not be verified');
  const org = await Organization.findById(orgId).lean();
  if (!org || org.razorpay?.pendingSubscriptionId !== subscriptionId) {
    throw ApiError.badRequest('This payment does not match this account’s checkout');
  }
  if (!org.pendingPlan) throw ApiError.badRequest('This payment does not match this account’s checkout');
  // The quote saved at checkout (offer / coupon included) is what was charged.
  const snap = org.pendingCheckout;
  const q = snap?.quote || quote(org, org.pendingPlan, org.pendingCycle || 'monthly');
  const used = q.coupon ? { _id: snap?.couponId, code: q.coupon.code } : null;
  const updated = await activate(orgId, {
    plan: org.pendingPlan,
    cycle: org.pendingCycle,
    subscriptionId,
  });
  const inv = await recordInvoice(orgId, {
    plan: updated.plan,
    billingCycle: updated.billingCycle,
    amount: q.firstPayment,
    currency: q.currency,
    description: `${q.planName} (${q.cycle})${used ? ` — coupon ${used.code}` : ''}`,
    razorpayPaymentId: paymentId,
    razorpaySubscriptionId: subscriptionId,
    periodStart: new Date(),
    periodEnd: updated.currentPeriodEnd,
    ...pricingFields(q, used),
  });
  await redeemCouponOf(orgId, inv, paymentId);
  return updated;
}

async function cancel(orgId) {
  const org = await Organization.findById(orgId);
  if (!org) throw ApiError.notFound('Company not found');
  const subId = org.razorpay?.subscriptionId;
  if (subId && configured()) {
    try {
      await rzp.post(`/subscriptions/${subId}/cancel`, { cancel_at_cycle_end: 1 }, { auth: auth() });
    } catch (err) {
      throw rzpFail(err, 'Cancel failed');
    }
  }
  org.cancelAtPeriodEnd = true;
  await org.save();
  orgService.invalidate(orgId);
  return org;
}

function verifyWebhookSignature(rawBody, signature) {
  if (!env.razorpay.webhookSecret || !rawBody) return false;
  const expected = crypto.createHmac('sha256', env.razorpay.webhookSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function orgForSubscription(sub) {
  if (!sub) return null;
  const byNote = sub.notes?.orgId ? await Organization.findById(sub.notes.orgId) : null;
  if (byNote) return byNote;
  return Organization.findOne({ $or: [{ 'razorpay.subscriptionId': sub.id }, { 'razorpay.pendingSubscriptionId': sub.id }] });
}

async function handleWebhook(event) {
  const type = event?.event;
  const sub = event?.payload?.subscription?.entity;
  const payment = event?.payload?.payment?.entity;

  // Add-on orders (no subscription): apply on payment.captured / order.paid,
  // so a customer who closed the browser after paying still gets the add-on.
  const orderId = payment?.order_id || event?.payload?.order?.entity?.id;
  if (!sub && orderId) {
    const invoice = await Invoice.findOne({ razorpayOrderId: orderId });
    if (invoice) {
      if (['payment.captured', 'order.paid'].includes(type)) {
        if (invoice.kind === 'plan') await applyPlanOrder(invoice.orgId, invoice, payment?.id || null);
        else await grantAddon(invoice.orgId, invoice, payment?.id || null);
      }
      else if (type === 'payment.failed' && invoice.status === 'pending') {
        await Invoice.updateOne({ _id: invoice._id }, { $set: { status: 'failed', description: `${invoice.description} — ${payment?.error_description || 'failed'}` } });
      }
    }
    return;
  }

  const org = await orgForSubscription(sub);
  if (!org) {
    logger.warn(`[billing] Razorpay webhook ${type} for unknown subscription ${sub?.id}`);
    return;
  }
  const isCurrent = org.razorpay?.subscriptionId === sub.id;
  const isPending = org.razorpay?.pendingSubscriptionId === sub.id;
  const paidPlans = ['starter', 'growth', 'builder'];

  switch (type) {
    case 'subscription.activated':
    case 'subscription.charged': {
      const periodEnd = sub.current_end ? new Date(sub.current_end * 1000) : undefined;
      // The plan comes from the subscription that was actually paid (its notes). pendingPlan is
      // used only when this IS the subscription we are waiting for — a stale pendingPlan can
      // never activate a plan for some other subscription.
      const notePlan = paidPlans.includes(sub.notes?.plan) ? sub.notes.plan : null;
      const noteCycle = ['monthly', 'annual'].includes(sub.notes?.cycle) ? sub.notes.cycle : null;
      const plan = notePlan || (isPending ? org.pendingPlan : isCurrent ? org.plan : null);
      const cycle = noteCycle || (isPending ? org.pendingCycle : isCurrent ? org.billingCycle : null);
      if (!plan || !paidPlans.includes(plan)) {
        logger.warn(`[billing] Ignoring ${type} for subscription ${sub.id}: it does not match this company's checkout`);
        break;
      }
      const snap = isPending ? org.pendingCheckout : null; // read before activate() clears it
      const updated = await activate(org._id, { plan, cycle, subscriptionId: sub.id, periodEnd, setupFeePaid: true });
      if (payment?.id && type === 'subscription.charged') {
        const used = snap?.quote?.coupon ? { _id: snap.couponId, code: snap.quote.coupon.code } : null;
        const inv = await recordInvoice(org._id, {
          plan: updated.plan,
          billingCycle: updated.billingCycle,
          amount: (payment.amount || 0) / (pricing.MINOR_UNIT[payment.currency] || 100),
          currency: payment.currency || 'INR',
          description: `${getPlan(updated.plan).name} (${updated.billingCycle})`,
          razorpayPaymentId: payment.id,
          razorpayInvoiceId: payment.invoice_id || null,
          razorpaySubscriptionId: sub.id,
          periodStart: sub.current_start ? new Date(sub.current_start * 1000) : null,
          periodEnd,
          ...(snap?.quote ? pricingFields(snap.quote, used) : {}),
        });
        await redeemCouponOf(org._id, inv, payment.id);
      }
      break;
    }
    case 'subscription.pending':
    case 'subscription.halted':
      if (isCurrent) {
        org.status = 'past_due';
        await org.save();
      }
      break;
    case 'subscription.cancelled':
    case 'subscription.completed':
      if (isPending) await clearPending(org._id); // checkout that never completed
      if (isCurrent) {
        org.status = 'cancelled';
        org.cancelAtPeriodEnd = false;
        await org.save();
      }
      break;
    case 'payment.failed':
      if (isPending) await clearPending(org._id);
      if (payment?.id) {
        await recordInvoice(org._id, {
          plan: org.plan,
          billingCycle: org.billingCycle,
          amount: (payment.amount || 0) / (pricing.MINOR_UNIT[payment.currency] || 100),
          currency: payment.currency || 'INR',
          status: 'failed',
          description: payment.error_description || 'Payment failed',
          razorpayPaymentId: payment.id,
          razorpaySubscriptionId: sub?.id || null,
        });
      }
      break;
    default:
      break;
  }
  orgService.invalidate(org._id);
}

/** Forgets a checkout that was dismissed / failed / never completed, so a stale pendingPlan can't linger. */
async function clearPending(orgId) {
  await Organization.updateOne(
    { _id: orgId },
    { $set: { pendingPlan: null, pendingCycle: null, pendingCheckout: null, 'razorpay.pendingSubscriptionId': null } },
  );
  orgService.invalidate(orgId);
}

/**
 * The customer closed the Razorpay popup without paying. Clears the pending plan; an unpaid
 * order stays `pending` on purpose (a payment that completes late is still applied by the webhook).
 */
async function abandonCheckout(orgId, { orderId, subscriptionId } = {}) {
  const org = await Organization.findById(orgId).lean();
  if (!org) return { cleared: false };
  if (subscriptionId && org.razorpay?.pendingSubscriptionId === subscriptionId) {
    await clearPending(orgId);
    if (configured()) {
      rzp.post(`/subscriptions/${subscriptionId}/cancel`, { cancel_at_cycle_end: 0 }, { auth: auth() }).catch((err) =>
        logger.warn('[billing] Could not cancel the abandoned subscription', { subscriptionId, error: err.response?.data?.error || err.message }));
    }
    return { cleared: true };
  }
  if (orderId && !org.razorpay?.pendingSubscriptionId) {
    const invoice = await Invoice.findOne({ orgId, razorpayOrderId: orderId, kind: 'plan', status: 'pending' }).lean();
    if (invoice && org.pendingPlan === invoice.plan) {
      await clearPending(orgId);
      return { cleared: true };
    }
  }
  return { cleared: false };
}

/** Platform admin: record an offline payment (UPI / bank transfer / cheque). */
async function recordOfflinePayment(orgId, { plan, cycle = 'monthly', amount, note, includesSetup = false }) {
  const org = await Organization.findById(orgId).lean();
  if (!org) throw ApiError.notFound('Company not found');
  const from = org.currentPeriodEnd && new Date(org.currentPeriodEnd) > new Date() ? new Date(org.currentPeriodEnd) : new Date();
  const periodEnd = periodEndFrom(cycle, from);
  const updated = await activate(orgId, { plan: plan || org.plan, cycle, periodEnd, setupFeePaid: includesSetup || org.razorpay?.setupFeePaid });
  await recordInvoice(orgId, {
    plan: updated.plan,
    billingCycle: cycle,
    amount: Number(amount) || 0,
    description: note ? `Offline: ${note}` : 'Offline payment',
    periodStart: from,
    periodEnd,
  });
  return updated;
}

module.exports = {
  configured,
  currencyOf,
  addonQuote,
  createAddonOrder,
  verifyAddonPayment,
  quote,
  quoteFor,
  assertPlanChangeAllowed,
  abandonCheckout,
  createCheckout,
  verifyCheckout,
  verifyPlanOrder,
  paymentMode,
  cancel,
  verifyWebhookSignature,
  handleWebhook,
  recordOfflinePayment,
  recordInvoice,
  sendInvoiceEmail: invoiceService.sendInvoiceEmail,
  activate,
  withGst: (inr) => pricing.withTax(inr, 'INR'),
};
