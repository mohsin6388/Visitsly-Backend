const mongoose = require('mongoose');
const { Schema } = mongoose;

/**
 * Discount coupon, created by platform staff and entered by customers in the
 * "Confirm your order" popup. The discount is ALWAYS re-validated server-side
 * at checkout (never trust a client amount) and applied BEFORE tax.
 */
const couponSchema = new Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    description: { type: String, default: '', trim: true },
    type: { type: String, enum: ['percent', 'flat'], required: true },
    // percent: 1–100. flat: an amount in `currency` (before tax).
    value: { type: Number, required: true, min: 0 },
    currency: { type: String, enum: ['INR', 'AED', 'USD', null], default: null }, // flat coupons only
    validFrom: { type: Date, default: null },
    validUntil: { type: Date, default: null },
    maxRedemptions: { type: Number, default: null, min: 1 }, // null = unlimited (all companies together)
    perOrgLimit: { type: Number, default: 1, min: 1 }, // how many times ONE company may use it
    redemptionCount: { type: Number, default: 0 }, // counted only after a successful payment
    applicablePlans: [{ type: String }], // empty = every paid plan
    applicableCycles: [{ type: String, enum: ['monthly', 'annual'] }], // empty = both
    active: { type: Boolean, default: true },
    // 'first' = discount on the first payment only (one-time order for that period);
    // 'all'   = discount on every renewal (auto-renewing subscription at the discounted price).
    appliesTo: { type: String, enum: ['first', 'all'], default: 'first' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Coupon', couponSchema);
