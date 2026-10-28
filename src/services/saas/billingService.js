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
const { getPlan, GST_RATE } = require('../../config/plans');

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

/** Monthly / annual price (INR, before GST) for this org, honouring a custom price. */
function priceFor(org, planCode, cycle) {
  const plan = getPlan(planCode);
  if (org?.priceOverride && planCode === org.plan) {
    return cycle === 'annual' ? org.priceOverride * 10 : org.priceOverride;
  }
  return cycle === 'annual' ? plan.annual : plan.monthly;
}

function quote(org, planCode, cycle) {
  const plan = getPlan(planCode);
  const base = priceFor(org, planCode, cycle);
  const setupFee = org?.razorpay?.setupFeePaid ? 0 : plan.setupFee || 0;
  return {
    plan: plan.code,
    planName: plan.name,
    cycle,
    price: base,
    priceWithGst: withGst(base),
    setupFee,
    setupFeeWithGst: withGst(setupFee),
    gstRate: GST_RATE,
    firstPayment: withGst(base) + withGst(setupFee),
  };
}

async function ensurePlanId(planCode, cycle, amountInr) {
  const envKey = `RAZORPAY_PLAN_${planCode.toUpperCase()}_${cycle.toUpperCase()}`;
  const amountPaise = withGst(amountInr) * 100;
  const standard = cycle === 'annual' ? getPlan(planCode).annual : getPlan(planCode).monthly;
  if (process.env[envKey] && amountInr === standard) return process.env[envKey];

  const existing = await RazorpayPlan.findOne({ code: planCode, cycle, amountPaise }).lean();
  if (existing) return existing.planId;

  try {
    const { data } = await rzp.post(
      '/plans',
      {
        period: cycle === 'annual' ? 'yearly' : 'monthly',
        interval: 1,
        item: {
          name: `${env.saas.productName} ${getPlan(planCode).name} (${cycle})`,
          amount: amountPaise,
          currency: 'INR',
          description: `Incl. ${Math.round(GST_RATE * 100)}% GST`,
        },
        notes: { code: planCode, cycle },
      },
      { auth: auth() }
    );
    await RazorpayPlan.create({ code: planCode, cycle, amountPaise, planId: data.id });
    logger.info(`[billing] Created Razorpay plan ${data.id} for ${planCode}/${cycle} — set ${envKey}=${data.id} to pin it`);
    return data.id;
  } catch (err) {
    throw rzpFail(err, 'Razorpay plan create failed');
  }
}

async function createCheckout(orgId, { plan: planCode, cycle = 'monthly' }, user) {
  const plan = getPlan(planCode);
  if (!plan.public || plan.code === 'trial') throw ApiError.badRequest('Ye plan online nahi kharida ja sakta');
  if (plan.contactSales) throw ApiError.badRequest('Enterprise ke liye sales team se baat karein');
  if (!configured()) {
    throw ApiError.badRequest('Online payment abhi set nahi hai. PropAI team se UPI/bank transfer se payment karke activate karwayein.', { code: 'BILLING_NOT_CONFIGURED' });
  }

  const org = await Organization.findById(orgId).lean();
  const q = quote(org, plan.code, cycle);
  const planId = await ensurePlanId(plan.code, cycle, q.price);

  const body = {
    plan_id: planId,
    total_count: cycle === 'annual' ? 10 : 120,
    quantity: 1,
    customer_notify: 1,
    notes: { orgId: String(orgId), plan: plan.code, cycle },
  };
  if (q.setupFee) {
    body.addons = [{ item: { name: 'One-time setup & onboarding', amount: q.setupFeeWithGst * 100, currency: 'INR' } }];
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
