const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const Invoice = require('../models/Invoice');
const AuditLog = require('../models/AuditLog');
const billing = require('../services/saas/billingService');
const orgService = require('../services/saas/orgService');
const { orgSummary } = require('../services/saas/orgSummary');
const { publicPlans, TRIAL_DAYS, PLANS, RECOMMENDED_PLAN, FEATURE_LABEL } = require('../config/plans');
const logger = require('../utils/logger');
const invoiceService = require('../services/billing/invoiceService');
const pricingService = require('../services/billing/pricingService');

/** Adds the live offer ("was / now") to each plan: plan.offer = { monthly?, annual? } (additive; absent when none). */
async function withOffers(plans, currency, { skipPlan } = {}) {
  const offers = await pricingService.offersByPlan(currency);
  return plans.map((p) => (offers[p.code] && p.code !== skipPlan ? { ...p, offer: offers[p.code] } : p));
}

/** GET /api/public/plans — pricing page (no login). */
const listPlans = asyncHandler(async (req, res) => {
  const env = require('../config/env');
  const pricing = require('../config/pricing');
  // ?country=AE (signup / pricing page) or ?currency=AED → prices in that currency.
  // IN → INR, AE → AED, every other country → USD.
  const country = String(req.query.country || '').trim().toUpperCase().slice(0, 8);
  const requested = String(req.query.currency || '').trim().toUpperCase();
  let cur = pricing.supported(requested) ? requested : null;
  if (!cur) cur = country ? pricing.currencyForCountry(country) : 'INR';
  return new ApiResponse(200, {
    currency: cur,
    country: country || null,
    supportedCurrencies: pricing.SUPPORTED_CURRENCIES,
    countries: pricing.COUNTRIES,
    taxRate: pricing.taxRate(cur),
    annualMonthsCharged: pricing.ANNUAL_MONTHS_CHARGED,
    plans: await withOffers(pricing.plansIn(cur, publicPlans()), cur),
    trial: { limits: PLANS.trial.limits, features: PLANS.trial.features, highlights: PLANS.trial.highlights },
    addons: pricing.addonsIn(cur),
    gstRate: cur === 'INR' ? pricing.GST_RATE : 0,
    recommendedPlan: RECOMMENDED_PLAN,
    featureLabels: FEATURE_LABEL,
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
  const pricing = require('../config/pricing');
  const currency = billing.currencyOf(req.org);
  let invoices = await Invoice.find({ orgId: req.org._id, status: { $ne: 'pending' } }).sort({ createdAt: -1 }).limit(50).lean();
  // Older paid invoices get their number the first time they are listed (idempotent, best effort).
  invoices = await invoiceService.numberOlderInvoices(invoices).catch(() => invoices);
  const now = Date.now();
  const activeAddons = (req.org.addonGrants || []).filter((g) => !g.expiresAt || new Date(g.expiresAt).getTime() > now);
  return new ApiResponse(200, {
    org: await orgSummary(req.org),
    currency,
    taxRate: pricing.taxRate(currency),
    // A company on a custom price keeps it: no offer is shown for its own plan.
    plans: await withOffers(pricing.plansIn(currency, publicPlans()), currency, { skipPlan: currency === 'INR' && req.org.priceOverride ? req.org.plan : null }),
    // True while a paid plan is running: the page shows only that plan (renewal still possible).
    activePlanLocked: req.org.status === 'active' && (!req.org.currentPeriodEnd || new Date(req.org.currentPeriodEnd) > new Date()),
    addons: pricing.addonsIn(currency),
    activeAddons,
    gstRate: currency === 'INR' ? pricing.GST_RATE : 0,
    annualMonthsCharged: pricing.ANNUAL_MONTHS_CHARGED,
    recommendedPlan: RECOMMENDED_PLAN[req.org.businessType] || null,
    featureLabels: FEATURE_LABEL,
    invoices,
  }).send(res);
});

/** GET /api/billing/quote?plan=growth&cycle=monthly */
const getQuote = asyncHandler(async (req, res) => {
  const { quote } = await billing.quoteFor(req.org, req.query.plan, req.query.cycle || 'monthly', { couponCode: req.query.coupon });
  return new ApiResponse(200, { quote }).send(res);
});

/** GET|POST /api/billing/coupon/validate { code, plan, cycle } → the discounted quote (nothing is created or counted). */
const validateCoupon = asyncHandler(async (req, res) => {
  const src = req.method === 'GET' ? req.query : req.body;
  const { quote, coupon } = await billing.quoteFor(req.org, src.plan, src.cycle || 'monthly', { couponCode: src.code });
  return new ApiResponse(200, {
    valid: true,
    coupon: { code: coupon.code, description: coupon.description || '', type: coupon.type, value: coupon.value, appliesTo: coupon.appliesTo || 'first' },
    quote,
  }).send(res);
});

/** POST /api/billing/checkout/cancel — the Razorpay popup was closed without paying. */
const checkoutCancel = asyncHandler(async (req, res) => {
  const result = await billing.abandonCheckout(req.org._id, req.body);
  return new ApiResponse(200, result).send(res);
});

/** POST /api/billing/checkout { plan, cycle } → Razorpay subscription for Checkout. */
const checkout = asyncHandler(async (req, res) => {
  const data = await billing.createCheckout(req.org._id, req.body, req.user);
  await AuditLog.create({ userId: req.user.actorId, action: 'billing.checkout', meta: { plan: req.body.plan, cycle: req.body.cycle, coupon: req.body.coupon || null }, ip: req.ip });
  return new ApiResponse(200, data).send(res);
});

/** POST /api/billing/verify — Razorpay Checkout success handler. */
const verify = asyncHandler(async (req, res) => {
  await billing.verifyCheckout(req.org._id, req.body);
  await AuditLog.create({ userId: req.user.actorId, action: 'billing.paid', meta: { paymentId: req.body.razorpay_payment_id }, ip: req.ip });
  return new ApiResponse(200, { org: await orgSummary(await orgService.getSnapshot(req.org._id, { fresh: true })) }, 'Payment successful — plan active').send(res);
});

/** POST /api/billing/verify-order — Razorpay Checkout success for a one-time plan payment. */
const verifyOrder = asyncHandler(async (req, res) => {
  const invoice = await billing.verifyPlanOrder(req.org._id, req.body);
  await AuditLog.create({ userId: req.user.actorId, action: 'billing.paid', meta: { paymentId: req.body.razorpay_payment_id, plan: invoice?.plan, mode: 'order' }, ip: req.ip });
  return new ApiResponse(200, { invoice, org: await orgSummary(await orgService.getSnapshot(req.org._id, { fresh: true })) }, 'Payment successful — plan active').send(res);
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

/** POST /api/billing/addon-checkout { addon, quantity } → Razorpay order. */
const addonCheckout = asyncHandler(async (req, res) => {
  const data = await billing.createAddonOrder(req.org._id, req.body, req.user);
  await AuditLog.create({ userId: req.user.actorId, action: 'billing.addon_checkout', meta: { addon: req.body.addon, quantity: req.body.quantity }, ip: req.ip });
  return new ApiResponse(200, data).send(res);
});

/** POST /api/billing/addon-verify — Razorpay Checkout success for an add-on order. */
const addonVerify = asyncHandler(async (req, res) => {
  const invoice = await billing.verifyAddonPayment(req.org._id, req.body);
  await AuditLog.create({ userId: req.user.actorId, action: 'billing.addon_paid', meta: { paymentId: req.body.razorpay_payment_id, addon: invoice?.addon?.key }, ip: req.ip });
  return new ApiResponse(200, { invoice, org: await orgSummary(await orgService.getSnapshot(req.org._id, { fresh: true })) }, 'Payment successful — add-on activated').send(res);
});

const OBJECT_ID = /^[a-f\d]{24}$/i;

/** GET /api/billing/invoices/:id/pdf — this company's own invoice only (another company's id is a 404). */
const invoicePdf = asyncHandler(async (req, res) => {
  if (!req.org) throw ApiError.badRequest('No company selected');
  if (!OBJECT_ID.test(String(req.params.id))) throw ApiError.notFound('Invoice not found');
  const { buffer, filename } = await invoiceService.pdfFor({ _id: req.params.id, orgId: req.org._id });
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Content-Length': buffer.length,
    'Cache-Control': 'private, no-store',
  });
  return res.status(200).send(buffer);
});

/** POST /api/billing/invoices/:id/resend — e-mail the invoice again (max 5 per invoice per day). */
const resendInvoice = asyncHandler(async (req, res) => {
  if (!req.org) throw ApiError.badRequest('No company selected');
  if (!OBJECT_ID.test(String(req.params.id))) throw ApiError.notFound('Invoice not found');
  const result = await invoiceService.resendInvoice(req.org._id, req.params.id);
  return new ApiResponse(200, { sent: true }, `Invoice emailed to ${result.to}`).send(res);
});

module.exports = { branding, listPlans, getBilling, getQuote, validateCoupon, checkoutCancel, checkout, verify, verifyOrder, cancel, razorpayWebhook, addonCheckout, addonVerify, invoicePdf, resendInvoice };
