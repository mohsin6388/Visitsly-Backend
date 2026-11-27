const mongoose = require('mongoose');
const { Schema } = mongoose;

/** One row per successful (or failed) subscription payment — shown on the Billing page. */
const invoiceSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    plan: { type: String, default: null },
    billingCycle: { type: String, default: null },
    amount: { type: Number, required: true }, // in `currency`, incl. tax, as charged
    currency: { type: String, default: 'INR' },
    status: { type: String, enum: ['pending', 'paid', 'failed', 'refunded'], default: 'paid' },
    kind: { type: String, enum: ['subscription', 'plan', 'addon', 'offline'], default: 'subscription' },
    addon: { key: { type: String, default: null }, quantity: { type: Number, default: null } },
    razorpayOrderId: { type: String, default: null, index: true, sparse: true },
    description: { type: String, default: '' },
    razorpayPaymentId: { type: String, default: null, index: true, sparse: true },
    razorpayInvoiceId: { type: String, default: null },
    razorpaySubscriptionId: { type: String, default: null },
    periodStart: { type: Date, default: null },
    periodEnd: { type: Date, default: null },
    paidAt: { type: Date, default: Date.now },

    // ---- Invoice document (added later; all optional, old rows have none of these) ----
    // Assigned only when the invoice becomes paid. No default on purpose: a
    // missing value (not null) keeps the unique + sparse index happy.
    invoiceNumber: { type: String, unique: true, sparse: true },
    numberingAt: { type: Date }, // short claim while a number is being assigned (no gaps / no double numbering)
    // `amount` stays the total as charged; subtotal + taxAmount = amount.
    taxRate: { type: Number },
    subtotal: { type: Number },
    taxAmount: { type: Number },
    // Snapshot of the buyer at payment time.
    billedTo: {
      name: { type: String },
      gstin: { type: String },
      email: { type: String },
      address: { type: String },
    },
    // Offer / coupon applied to this payment (all optional; amounts are before tax, in `currency`).
    pricing: {
      listSubtotal: { type: Number },
      offerDiscount: { type: Number },
      couponCode: { type: String },
      couponId: { type: Schema.Types.ObjectId },
      couponDiscount: { type: Number },
    },
    // Invoice e-mail: emailedAt = claim/sent time (null → now, atomic), so it goes out once.
    emailedAt: { type: Date },
    emailError: { type: String },
    emailAttempts: { type: Number, default: 0 },
    // "Email me a copy" limit: 5 per invoice per day.
    emailResends: { day: { type: String }, count: { type: Number } },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Invoice', invoiceSchema);
