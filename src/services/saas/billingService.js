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
const { getPlan, getRegion, getCycle, regionOf, isSoldIn, priceFor: catalogPrice } = require('../../config/plans');

/**
 * Razorpay Subscriptions billing for Visitsly / PropAI — India (INR + GST)
 * and UAE (AED + VAT).
 *
 * Flow: Billing page → POST /billing/checkout → Razorpay Checkout popup
 * (card / UPI AutoPay / netbanking e-mandate) → POST /billing/verify →
 * company becomes `active`. Renewals, failures and cancellations arrive on
 * POST /api/webhooks/razorpay and keep the company status in sync.
 *
 * Cycles: monthly (+ setup fee), halfyearly (6 × monthly, setup waived),
 * annual (10 × monthly, setup waived).
 *
 * UAE (AED) online checkout needs Razorpay international payments enabled on
 * the account — set RAZORPAY_INTL_ENABLED=true once it is. Until then UAE
 * customers pay by bank transfer and the platform admin activates them with
 * "Record offline payment".
 *
 * Without Razorpay keys the platform admin can still activate companies and
 * record offline payments from the Platform panel.
 */
const rzp = axios.create({ baseURL: 'https://api.razorpay.com/v1', timeout: 20000 });

function configured() {
  return Boolean(env.razorpay.keyId && env.razorpay.keySecret);
}

function intlEnabled() {
  return String(process.env.RAZORPAY_INTL_ENABLED || '').toLowerCase() === 'true';
}

function auth() {
  return { username: env.razorpay.keyId, password: env.razorpay.keySecret };
}

function rzpFail(err, fallback) {
  const e = err.response?.data?.error;
  logger.error('[billing] Razorpay API error', { error: e || err.message });
  return ApiError.badRequest(e?.description || err.message || fallback, { code: 'RAZORPAY_ERROR' });
}

/** Amount + the region's tax (GST 18% in India, VAT in the UAE). */
function withTax(amount, region = 'in') {
  return Math.round(amount * (1 + getRegion(region).taxRate));
}
// Back-compat name (India).
const withGst = (inr) => withTax(inr, 'in');

/** Price for one billing period (before tax) for this org, honouring a custom monthly price. */
function priceFor(org, planCode, cycle) {
  const c = getCycle(cycle);
  if (org?.priceOverride && planCode === org.plan) return org.priceOverride * c.multiplier;
  return catalogPrice(planCode, regionOf(org), c.code).periodPrice;
}

function quote(org, planCode, cycle = 'monthly') {
  const plan = getPlan(planCode);
  const region = getRegion(org);
  const c = getCycle(cycle);
  const catalog = catalogPrice(plan.code, region.code, c.code);
  const base = priceFor(org, plan.code, c.code);
  // Setup is charged once, and never on half-yearly / yearly prepay.
  const setupFee = org?.razorpay?.setupFeePaid ? 0 : catalog.setupDue;
  return {
    plan: plan.code,
    planName: plan.name,
    cycle: c.code,
    cycleLabel: c.label,
    months: c.months,
    region: region.code,
    currency: region.currency,
    taxLabel: region.taxLabel,
    taxRate: region.taxRate,
    price: base,
    priceWithTax: withTax(base, region.code),
    setupFee,
    setupFeeWithTax: withTax(setupFee, region.code),
    setupWaived: catalog.setupWaived && !org?.razorpay?.setupFeePaid,
    firstPayment: withTax(base, region.code) + withTax(setupFee, region.code),
    // Back-compat field names used by the old Billing page.
    gstRate: region.taxRate,
    priceWithGst: withTax(base, region.code),
    setupFeeWithGst: withTax(setupFee, region.code),
  };
}

const PERIOD = {
  monthly: { period: 'monthly', interval: 1, totalCount: 120 },
  halfyearly: { period: 'monthly', interval: 6, totalCount: 20 },
  annual: { period: 'yearly', interval: 1, totalCount: 10 },
};

async function ensurePlanId(planCode, cycle, amount, region) {
  const reg = getRegion(region);
  const envKey = `RAZORPAY_PLAN_${planCode.toUpperCase()}_${cycle.toUpperCase()}${reg.code === 'in' ? '' : `_${reg.code.toUpperCase()}`}`;
  const amountMinor = withTax(amount, reg.code) * 100;
  const standard = catalogPrice(planCode, reg.code, cycle).periodPrice;
  if (process.env[envKey] && amount === standard) return process.env[envKey];

  const existing = await RazorpayPlan.findOne({ code: planCode, cycle, amountPaise: amountMinor, currency: reg.currency }).lean();
  if (existing) return existing.planId;

  const p = PERIOD[cycle] || PERIOD.monthly;
  try {
    const { data } = await rzp.post(
      '/plans',
      {
        period: p.period,
        interval: p.interval,
        item: {
          name: `${env.saas.productName} ${getPlan(planCode).name} (${cycle}${reg.code === 'in' ? '' : `, ${reg.name}`})`,
          amount: amountMinor,
          currency: reg.currency,
          description: reg.taxRate ? `Incl. ${Math.round(reg.taxRate * 100)}% ${reg.taxLabel}` : `Excl. ${reg.taxLabel}`,
        },
        notes: { code: planCode, cycle, region: reg.code },
      },
      { auth: auth() }
    );
    await RazorpayPlan.create({ code: planCode, cycle, amountPaise: amountMinor, currency: reg.currency, planId: data.id });
    logger.info(`[billing] Created Razorpay plan ${data.id} for ${planCode}/${cycle}/${reg.code} — set ${envKey}=${data.id} to pin it`);
    return data.id;
  } catch (err) {
    throw rzpFail(err, 'Razorpay plan create failed');
  }
}

async function createCheckout(orgId, { plan: planCode, cycle = 'monthly' }, user) {
  const plan = getPlan(planCode);
  if (!plan.public || plan.code === 'trial') throw ApiError.badRequest('Ye plan online nahi kharida ja sakta');
  if (plan.contactSales) throw ApiError.badRequest('Enterprise ke liye sales team se baat karein');

  const org = await Organization.findById(orgId).lean();
  const region = getRegion(org);
  if (!isSoldIn(plan.code, region.code)) {
    throw ApiError.badRequest(`${plan.name} plan ${region.name} mein available nahi hai.`);
  }
  if (!configured()) {
    throw ApiError.badRequest('Online payment abhi set nahi hai. Visitsly team se UPI/bank transfer se payment karke activate karwayein.', { code: 'BILLING_NOT_CONFIGURED' });
  }
  if (region.code !== 'in' && !intlEnabled()) {
    throw ApiError.badRequest('UAE (AED) online payment abhi on nahi hai. Bank transfer se payment karein — hamari team plan activate kar degi.', { code: 'INTL_BILLING_NOT_ENABLED' });
  }

  const c = getCycle(cycle);
  const q = quote(org, plan.code, c.code);
  const planId = await ensurePlanId(plan.code, c.code, q.price, region.code);

  const body = {
    plan_id: planId,
    total_count: (PERIOD[c.code] || PERIOD.monthly).totalCount,
    quantity: 1,
    customer_notify: 1,
    notes: { orgId: String(orgId), plan: plan.code, cycle: c.code, region: region.code },
  };
  if (q.setupFee) {
    body.addons = [{ item: { name: 'One-time setup & onboarding', amount: q.setupFeeWithTax * 100, currency: region.currency } }];
  }

  let sub;
  try {
    ({ data: sub } = await rzp.post('/subscriptions', body, { auth: auth() }));
  } catch (err) {
    throw rzpFail(err, 'Razorpay subscription create failed');
  }

  await Organization.updateOne(
    { _id: orgId },
    { $set: { pendingPlan: plan.code, pendingCycle: c.code, 'razorpay.pendingSubscriptionId': sub.id, 'razorpay.planId': planId } }
  );
  orgService.invalidate(orgId);

  return {
    keyId: env.razorpay.keyId,
    subscriptionId: sub.id,
    quote: q,
    prefill: { name: user?.name || '', email: org.billingEmail || user?.email || '', contact: org.phone || '' },
    productName: env.saas.productName,
  };
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
  else if (cycle === 'halfyearly') d.setMonth(d.getMonth() + 6);
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
    // A waived setup (half-yearly / yearly prepay) also counts as done.
    setupFeePaid: q.setupFee > 0 || q.setupWaived || org.razorpay?.setupFeePaid,
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
          amount: Math.round((payment.amount || 0) / 100),
          currency: payment.currency || getRegion(updated).currency,
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
          amount: Math.round((payment.amount || 0) / 100),
          currency: payment.currency || getRegion(org).currency,
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
    currency: getRegion(org).currency,
    description: note ? `Offline: ${note}` : 'Offline payment',
    periodStart: from,
    periodEnd,
  });
  return updated;
}

module.exports = {
  configured,
  quote,
  createCheckout,
  verifyCheckout,
  cancel,
  verifyWebhookSignature,
  handleWebhook,
  recordOfflinePayment,
  activate,
  withGst,
  withTax,
  intlEnabled,
};
