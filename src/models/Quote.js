const mongoose = require('mongoose');
const { Schema } = mongoose;

/** Cost sheet / quotation for a unit, shareable as a PDF link or on WhatsApp. */
const quoteSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    number: { type: String, required: true }, // Q-2026-0001
    token: { type: String, required: true, unique: true }, // public PDF link
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', default: null, index: true },
    propertyId: { type: Schema.Types.ObjectId, ref: 'Property', default: null },
    customer: { name: String, phone: String, email: String },
    project: { type: String, required: true },
    unit: { tower: String, unitNo: String, floor: String, bhk: String, areaSqft: Number, facing: String },
    pricing: {
      ratePerSqft: { type: Number, default: 0 },
      baseAmount: { type: Number, default: 0 }, // used when no rate/area
      items: [{ label: String, amount: Number, taxable: { type: Boolean, default: true } }], // PLC, parking, club, EDC/IDC…
      discount: { type: Number, default: 0 },
      gstPct: { type: Number, default: 5 },
      stampDutyPct: { type: Number, default: 7 },
      registrationPct: { type: Number, default: 1 },
    },
    totals: {
      base: Number,
      extras: Number,
      discount: Number,
      agreementValue: Number,
      gst: Number,
      stampDuty: Number,
      registration: Number,
      grandTotal: Number,
    },
    paymentPlan: [{ milestone: String, pct: Number, amount: Number }],
    validTill: { type: Date, default: null },
    notes: { type: String, default: '' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    sentAt: { type: Date, default: null },
    viewedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

quoteSchema.index({ ownerId: 1, number: 1 }, { unique: true });

module.exports = mongoose.model('Quote', quoteSchema);
