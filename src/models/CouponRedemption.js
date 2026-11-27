const mongoose = require('mongoose');
const { Schema } = mongoose;

/** One row per coupon use, written ONLY after the payment succeeded. `ref` (payment/order id) makes it idempotent. */
const couponRedemptionSchema = new Schema(
  {
    couponId: { type: Schema.Types.ObjectId, ref: 'Coupon', required: true, index: true },
    code: { type: String, required: true },
    orgId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    invoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice', default: null },
    ref: { type: String, required: true }, // razorpay order id or payment id
    plan: { type: String, default: null },
    billingCycle: { type: String, default: null },
    amountOff: { type: Number, default: 0 }, // before tax, in `currency`
    currency: { type: String, default: 'INR' },
  },
  { timestamps: true }
);
couponRedemptionSchema.index({ couponId: 1, ref: 1 }, { unique: true });

module.exports = mongoose.model('CouponRedemption', couponRedemptionSchema);
