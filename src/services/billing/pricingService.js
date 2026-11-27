/**
 * Offers (struck-through prices) and coupons for plan checkout.
 *
 * Order of maths (all before tax, same rounding as config/pricing.js):
 *   list price  →  offer price (admin PlanOffer, or the company's priceOverride)
 *               →  minus coupon discount
 *               →  + tax  (pricing.withTax)  =  TOTAL charged / invoiced.
 */
const Coupon = require('../../models/Coupon');
const CouponRedemption = require('../../models/CouponRedemption');
const PlanOffer = require('../../models/PlanOffer');
const ApiError = require('../../utils/ApiError');
const logger = require('../../utils/logger');
const pricing = require('../../config/pricing');

const normaliseCode = (code) => String(code || '').trim().toUpperCase().replace(/\s+/g, '');
const roundFor = (v, currency) => (currency === 'INR' ? Math.round(v) : Math.round(v * 100) / 100);
const liveWindow = (doc, now = new Date()) =>
  (!doc.validFrom || new Date(doc.validFrom) <= now) && (!doc.validUntil || new Date(doc.validUntil) >= now);

const couponError = (code, message) => ApiError.badRequest(message, { code });

/* ----------------------------- offers ----------------------------- */
/** Active offers for a currency → { 'growth:monthly': {offerPrice,label,...} }. Never throws (a DB hiccup = list prices). */
async function activeOffers(currency, now = new Date()) {
  try {
    const rows = await PlanOffer.find({ currency, active: true }).lean();
    const map = {};
    for (const o of rows) if (liveWindow(o, now)) map[`${o.plan}:${o.cycle}`] = o;
    return map;
  } catch (err) {
    logger.warn('[pricing] could not load plan offers — using list prices', { error: err.message });
    return {};
  }
}

/** → { listPrice, offerPrice, percentOff, label } when an offer is live AND lower than the list price. */
function offerFor(offers, planCode, cycle, currency) {
  const o = offers?.[`${planCode}:${cycle}`];
  if (!o) return null;
  const p = pricing.planPrice(planCode, currency);
  const listPrice = cycle === 'annual' ? p.annual : p.monthly;
  if (!listPrice || !(o.offerPrice < listPrice)) return null;
  return {
    listPrice,
    offerPrice: o.offerPrice,
    percentOff: Math.round(((listPrice - o.offerPrice) / listPrice) * 100),
    label: o.label || '',
  };
}

/** All live offers in a currency, shaped for the plan cards: { growth: { monthly: {...}, annual: {...} } }. */
async function offersByPlan(currency) {
  const offers = await activeOffers(currency);
  const out = {};
  for (const key of Object.keys(offers)) {
    const [plan, cycle] = key.split(':');
    const off = offerFor(offers, plan, cycle, currency);
    if (off) (out[plan] = out[plan] || {})[cycle] = off;
  }
  return out;
}

/* ----------------------------- coupons ---------------------------- */
/** Discount in `currency` (before tax) for a base price. Never more than the base. */
function couponDiscount(coupon, base, currency) {
  if (!coupon || !(base > 0)) return 0;
  const raw = coupon.type === 'percent' ? (base * coupon.value) / 100 : coupon.value;
  return Math.min(base, Math.max(0, roundFor(raw, currency)));
}

/**
 * Loads and checks a coupon for this company / plan / cycle / currency.
 * Throws ApiError(400, { code }) with a customer-facing message.
 */
async function validateCoupon(rawCode, { orgId, plan, cycle, currency, now = new Date() }) {
  const code = normaliseCode(rawCode);
  if (!code) throw couponError('COUPON_INVALID', 'Please enter a coupon code.');
  const coupon = await Coupon.findOne({ code }).lean();
  if (!coupon || !coupon.active) throw couponError('COUPON_INVALID', 'This coupon code is not valid.');
  if (coupon.validFrom && new Date(coupon.validFrom) > now) throw couponError('COUPON_NOT_STARTED', 'This coupon is not active yet.');
  if (coupon.validUntil && new Date(coupon.validUntil) < now) throw couponError('COUPON_EXPIRED', 'This coupon has expired.');
  if (coupon.applicablePlans?.length && !coupon.applicablePlans.includes(plan)) {
    throw couponError('COUPON_NOT_FOR_PLAN', 'This coupon is not valid for the selected plan.');
  }
  if (coupon.applicableCycles?.length && !coupon.applicableCycles.includes(cycle)) {
    throw couponError('COUPON_NOT_FOR_CYCLE', `This coupon is not valid for ${cycle === 'annual' ? 'yearly' : 'monthly'} billing.`);
  }
  if (coupon.type === 'flat' && coupon.currency && coupon.currency !== currency) {
    throw couponError('COUPON_NOT_FOR_CURRENCY', `This coupon is only valid for ${coupon.currency} payments.`);
  }
  if (coupon.maxRedemptions != null && (coupon.redemptionCount || 0) >= coupon.maxRedemptions) {
    throw couponError('COUPON_EXHAUSTED', 'This coupon has reached its usage limit.');
  }
  if (orgId) {
    const used = await CouponRedemption.countDocuments({ couponId: coupon._id, orgId });
    if (used >= (coupon.perOrgLimit || 1)) throw couponError('COUPON_USED', 'You have already used this coupon.');
  }
  return coupon;
}

/**
 * Counts a coupon use — called ONLY after the payment succeeded. Idempotent per
 * `ref` (webhook + browser verify may both report the same payment).
 */
async function recordRedemption({ coupon, couponId, code, orgId, invoiceId, ref, plan, cycle, amountOff, currency }) {
  try {
    const id = couponId || coupon?._id;
    if (!id || !ref) return false;
    if (await CouponRedemption.findOne({ couponId: id, ref }).lean()) return false;
    await CouponRedemption.create({ couponId: id, code: code || coupon?.code, orgId, invoiceId: invoiceId || null, ref, plan, billingCycle: cycle, amountOff, currency });
    await Coupon.updateOne({ _id: id }, { $inc: { redemptionCount: 1 } });
    return true;
  } catch (err) {
    if (/E11000|duplicate/i.test(err.message)) return false; // lost a race with the other reporter
    logger.warn('[billing] could not record coupon redemption', { error: err.message });
    return false;
  }
}

module.exports = {
  normaliseCode,
  roundFor,
  activeOffers,
  offerFor,
  offersByPlan,
  couponDiscount,
  validateCoupon,
  recordRedemption,
};
