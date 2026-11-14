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
    kind: { type: String, enum: ['subscription', 'addon', 'offline'], default: 'subscription' },
    addon: { key: { type: String, default: null }, quantity: { type: Number, default: null } },
    razorpayOrderId: { type: String, default: null, index: true, sparse: true },
    description: { type: String, default: '' },
    razorpayPaymentId: { type: String, default: null, index: true, sparse: true },
    razorpayInvoiceId: { type: String, default: null },
    razorpaySubscriptionId: { type: String, default: null },
    periodStart: { type: Date, default: null },
    periodEnd: { type: Date, default: null },
    paidAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Invoice', invoiceSchema);
