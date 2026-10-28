const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const Invoice = require('../models/Invoice');
const AuditLog = require('../models/AuditLog');
const billing = require('../services/saas/billingService');
const orgService = require('../services/saas/orgService');
const { orgSummary } = require('../services/saas/orgSummary');
const { publicPlans, ADDONS, GST_RATE, TRIAL_DAYS, PLANS } = require('../config/plans');
const logger = require('../utils/logger');

/** GET /api/public/plans — pricing page (no login). */
const listPlans = asyncHandler(async (req, res) => {
  const env = require('../config/env');
  return new ApiResponse(200, {
    plans: publicPlans(),
    trial: { limits: PLANS.trial.limits, features: PLANS.trial.features, highlights: PLANS.trial.highlights },
    addons: ADDONS,
    gstRate: GST_RATE,
    trialDays: TRIAL_DAYS,
    sales: { phone: env.saas.salesPhone, email: env.saas.salesEmail },
  }).send(res);
});

/** GET /api/public/branding?host=crm.client.com — white-label login screen. */
const branding = asyncHandler(async (req, res) => {
  const Organization = require('../models/Organization');
  const host = String(req.query.host || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const org = host ? await Organization.findOne({ 'branding.customDomain': host }).select('name branding').lean() : null;
  return new ApiResponse(200, {
    branding: org ? { productName: org.branding.productName || org.name, logoUrl: org.branding.logoUrl || '', primaryColor: org.branding.primaryColor || '', companyName: org.name } : null,
  }).send(res);
});

/** GET /api/billing — plan, usage, invoices for the Billing page. */
const getBilling = asyncHandler(async (req, res) => {
  if (!req.org) throw ApiError.badRequest('No company selected');
  const invoices = await Invoice.find({ orgId: req.org._id }).sort({ createdAt: -1 }).limit(50).lean();
  return new ApiResponse(200, {
    org: await orgSummary(req.org),
    plans: publicPlans(),
    addons: ADDONS,
    gstRate: GST_RATE,
    invoices,
  }).send(res);
});

/** GET /api/billing/quote?plan=growth&cycle=monthly */
const getQuote = asyncHandler(async (req, res) => {
  return new ApiResponse(200, { quote: billing.quote(req.org, req.query.plan, req.query.cycle || 'monthly') }).send(res);
});

/** POST /api/billing/checkout { plan, cycle } → Razorpay subscription for Checkout. */
const checkout = asyncHandler(async (req, res) => {
  const data = await billing.createCheckout(req.org._id, req.body, req.user);
  await AuditLog.create({ userId: req.user.actorId, action: 'billing.checkout', meta: { plan: req.body.plan, cycle: req.body.cycle }, ip: req.ip });
  return new ApiResponse(200, data).send(res);
});

/** POST /api/billing/verify — Razorpay Checkout success handler. */
const verify = asyncHandler(async (req, res) => {
  await billing.verifyCheckout(req.org._id, req.body);
  await AuditLog.create({ userId: req.user.actorId, action: 'billing.paid', meta: { paymentId: req.body.razorpay_payment_id }, ip: req.ip });
  return new ApiResponse(200, { org: await orgSummary(await orgService.getSnapshot(req.org._id, { fresh: true })) }, 'Payment successful — plan active').send(res);
});

/** POST /api/billing/cancel — cancels at the end of the current period. */
const cancel = asyncHandler(async (req, res) => {
  await billing.cancel(req.org._id);
  await AuditLog.create({ userId: req.user.actorId, action: 'billing.cancel', ip: req.ip });
  return new ApiResponse(200, { org: await orgSummary(await orgService.getSnapshot(req.org._id, { fresh: true })) }, 'Subscription will end at the period end').send(res);
});

/** POST /api/webhooks/razorpay — public, HMAC-verified. */
const razorpayWebhook = async (req, res) => {
  if (!billing.verifyWebhookSignature(req.rawBody, req.get('X-Razorpay-Signature'))) {
    logger.warn('[billing] Razorpay webhook signature mismatch');
    return res.sendStatus(400);
  }
  try {
    await billing.handleWebhook(req.body);
  } catch (err) {
    logger.error('[billing] Razorpay webhook failed', { error: err.message });
    return res.sendStatus(500); // Razorpay retries
  }
  return res.json({ ok: true });
};

module.exports = { branding, listPlans, getBilling, getQuote, checkout, verify, cancel, razorpayWebhook };
