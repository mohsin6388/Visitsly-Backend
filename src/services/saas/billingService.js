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
const { getPlan, GST_RATE, ADDONS } = require('../../config/plans');
const pricing = require('../../config/pricing');

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

const withGst = (inr) => Math.round(inr * (1 + GST_RATE));

/** The currency this company is billed in (from its signup country). */
function currencyOf(org) {
  const cur = String(org?.currency || pricing.currencyForCountry(org?.country) || 'INR').toUpperCase();
  return pricing.supported(cur) ? cur : 'INR';
}

/** Monthly / annual price (before tax) for this org, honouring a custom INR price. */
function priceFor(org, planCode, cycle, currency = currencyOf(org)) {
  if (currency === 'INR' && org?.priceOverride && planCode === org.plan) {
    return cycle === 'annual' ? org.priceOverride * 10 : org.priceOverride;
  }
  const p = pricing.planPrice(planCode, currency);
  return cycle === 'annual' ? p.annual : p.monthly;
}

function quote(org, planCode, cycle, currencyOverride) {
  const plan = getPlan(planCode);
  const currency = currencyOverride || currencyOf(org);
  const base = priceFor(org, planCode, cycle, currency);
  const setupFee = org?.razorpay?.setupFeePaid ? 0 : pricing.planPrice(plan.code, currency).setupFee || 0;
  const taxRate = pricing.taxRate(currency);
  const priceWithTax = pricing.withTax(base, currency);
  const setupWithTax = pricing.withTax(setupFee, currency);
  return {
    plan: plan.code,
    planName: plan.name,
    cycle,
    currency,
    price: base,
    priceWithTax,
    setupFee,
    setupFeeWithTax: setupWithTax,
    taxRate,
    taxLabel: currency === 'INR' ? 'GST' : taxRate ? 'Tax' : null,
    firstPayment: Math.round((priceWithTax + setupWithTax) * 100) / 100,
    // Back-compat field names used by older clients.
    priceWithGst: priceWithTax,
    setupFeeWithGst: setupWithTax,
    gstRate: currency === 'INR' ? GST_RATE : 0,
  };
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

async function createCheckout(orgId, { plan: planCode, cycle = 'monthly' }, user) {
  const plan = getPlan(planCode);
  if (!plan.public || plan.code === 'trial') throw ApiError.badRequest('Ye plan online nahi kharida ja sakta');
  if (plan.contactSales) throw ApiError.badRequest('Enterprise ke liye sales team se baat karein');
  if (!configured()) {
    throw ApiError.badRequest('Online payment abhi set nahi hai. Team se UPI/bank transfer se payment karke activate karwayein.', { code: 'BILLING_NOT_CONFIGURED' });
  }

  const org = await Organization.findById(orgId).lean();
  let q = quote(org, plan.code, cycle);
  let planId;
  let currencyNote = null;
  try {
    planId = await ensurePlanId(plan.code, cycle, q.price, q.currency);
  } catch (err) {
    if (err.code !== 'CURRENCY_NOT_ENABLED') throw err;
    // International payments not enabled on the Razorpay account yet → bill in INR.
    logger.warn(`[billing] ${q.currency} not enabled on Razorpay — falling back to INR for org ${orgId}`);
    currencyNote = `${q.currency} payment abhi available nahi hai, isliye payment INR mein hoga.`;
    q = quote(org, plan.code, cycle, 'INR');
    planId = await ensurePlanId(plan.code, cycle, q.price, 'INR');
  }

  const body = {
    plan_id: planId,
    total_count: cycle === 'annual' ? 10 : 120,
    quantity: 1,
    customer_notify: 1,
    notes: { orgId: String(orgId), plan: plan.code, cycle, currency: q.currency },
  };
  if (q.setupFee) {
    body.addons = [{ item: { name: 'One-time setup & onboarding', amount: pricing.toMinor(q.setupFeeWithTax, q.currency), currency: q.currency } }];
  }

  let sub;
  try {
    ({ data: sub } = await rzp.post('/subscriptions', body, { auth: auth() }));
  } catch (err) {
    throw rzpFail(err, 'Razorpay subscription create failed');
  }

  await Organization.updateOne(
    { _id: orgId },
    { $set: { pendingPlan: plan.code, pendingCycle: cycle, 'razorpay.pendingSubscriptionId': sub.id, 'razorpay.planId': planId } }
  );
  orgService.invalidate(orgId);

  return {
    keyId: env.razorpay.keyId,
    subscriptionId: sub.id,
    quote: q,
    currencyNote,
    prefill: { name: user?.name || '', email: org.billingEmail || user?.email || '', contact: org.phone || '' },
    productName: env.saas.productName,
  };
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
};

function addonQuote(org, key, quantity) {
  const rule = ADDON_RULES[key];
  if (!rule || !ADDONS[key]) throw ApiError.badRequest('Ye add-on available nahi hai');
  const qty = Math.min(Math.max(Math.round(Number(quantity) || rule.min), rule.min), rule.max);
  const currency = currencyOf(org);
  const unit = pricing.addonPrice(key, currency);
  const amount = Math.round(unit * qty * 100) / 100;
  return { key, name: ADDONS[key].name, quantity: qty, unitPrice: unit, currency, amount, total: pricing.withTax(amount, currency), taxRate: pricing.taxRate(currency), months: rule.months };
}

async function createAddonOrder(orgId, { addon, quantity }, user) {
  if (!configured()) throw ApiError.badRequest('Online payment abhi set nahi hai. Team se add-on activate karwayein.', { code: 'BILLING_NOT_CONFIGURED' });
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
  await Organization.updateOne({ _id: orgId }, { $push: { addonGrants: { key, quantity: qty, expiresAt, paymentId } } });
  if (key === 'leadRevival') {
    try {
      const PlatformRequest = require('../../models/PlatformRequest');
      await PlatformRequest.create({ orgId, type: 'addon', addon: key, quantity: qty, message: 'Paid in-app — lead revival campaign set up karein', status: 'open' });
    } catch (err) {
      logger.warn('[billing] could not create lead revival request', { error: err.message });
    }
  }
  orgService.invalidate(orgId);
  return true;
}

async function verifyAddonPayment(orgId, { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature }) {
  if (!verifyOrderSignature(orderId, paymentId, signature)) throw ApiError.badRequest('Payment verify nahi hua. Agar paisa kat gaya hai to 5-10 minute mein apne aap update ho jayega, warna support se baat karein.');
  const invoice = await Invoice.findOne({ orgId, razorpayOrderId: orderId });
  if (!invoice) throw ApiError.badRequest('Ye payment is account ke order se match nahi karta');
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

  org.plan = plan || org.pendingPlan || org.plan;
  org.billingCycle = cycle || org.pendingCycle || org.billingCycle;
  org.status = 'active';
  org.currentPeriodEnd = periodEnd || periodEndFrom(org.billingCycle);
  org.cancelAtPeriodEnd = false;
  org.suspendedReason = null;
  if (subscriptionId) {
    org.razorpay.subscriptionId = subscriptionId;
    if (org.razorpay.pendingSubscriptionId === subscriptionId) org.razorpay.pendingSubscriptionId = null;
  }
  if (setupFeePaid) org.razorpay.setupFeePaid = true;
  org.pendingPlan = null;
  org.pendingCycle = null;
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
  return Invoice.create({ orgId, ...data });
}

async function verifyCheckout(orgId, { razorpay_payment_id: paymentId, razorpay_subscription_id: subscriptionId, razorpay_signature: signature }) {
  if (!verifySignature(paymentId, subscriptionId, signature)) throw ApiError.badRequest('Payment signature verify nahi hua');
  const org = await Organization.findById(orgId).lean();
  if (!org || org.razorpay?.pendingSubscriptionId !== subscriptionId) {
    throw ApiError.badRequest('Ye payment is account ke checkout se match nahi karta');
  }
  const q = quote(org, org.pendingPlan, org.pendingCycle || 'monthly');
  const updated = await activate(orgId, {
    plan: org.pendingPlan,
    cycle: org.pendingCycle,
    subscriptionId,
    setupFeePaid: q.setupFee > 0 || org.razorpay?.setupFeePaid,
  });
  await recordInvoice(orgId, {
    plan: updated.plan,
    billingCycle: updated.billingCycle,
    amount: q.firstPayment,
    currency: q.currency,
    description: `${q.planName} (${q.cycle})${q.setupFee ? ' + setup' : ''}`,
    razorpayPaymentId: paymentId,
    razorpaySubscriptionId: subscriptionId,
    periodStart: new Date(),
    periodEnd: updated.currentPeriodEnd,
  });
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
      if (['payment.captured', 'order.paid'].includes(type)) await grantAddon(invoice.orgId, invoice, payment?.id || null);
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

  switch (type) {
    case 'subscription.activated':
    case 'subscription.charged': {
      const periodEnd = sub.current_end ? new Date(sub.current_end * 1000) : undefined;
      const plan = sub.notes?.plan || (isPending ? org.pendingPlan : org.plan);
      const cycle = sub.notes?.cycle || (isPending ? org.pendingCycle : org.billingCycle);
      const updated = await activate(org._id, { plan, cycle, subscriptionId: sub.id, periodEnd, setupFeePaid: true });
      if (payment?.id && type === 'subscription.charged') {
        await recordInvoice(org._id, {
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
        });
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
      if (isCurrent) {
        org.status = 'cancelled';
        org.cancelAtPeriodEnd = false;
        await org.save();
      }
      break;
    case 'payment.failed':
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
  createCheckout,
  verifyCheckout,
  cancel,
  verifyWebhookSignature,
  handleWebhook,
  recordOfflinePayment,
  activate,
  withGst,
};
