const mongoose = require('mongoose');
const { Schema } = mongoose;

/**
 * Admin-set offer price for one plan / cycle / currency ("was ₹7,999, now ₹5,999").
 * `offerPrice` is the price BEFORE tax and must be lower than the list price
 * (config/pricing.js). Organization-independent; a per-company custom price
 * (Organization.priceOverride) still wins over an offer.
 */
const planOfferSchema = new Schema(
  {
    plan: { type: String, enum: ['starter', 'growth', 'builder'], required: true },
    cycle: { type: String, enum: ['monthly', 'annual'], required: true },
    currency: { type: String, enum: ['INR', 'AED', 'USD'], required: true },
    offerPrice: { type: Number, required: true, min: 0 },
    label: { type: String, default: '', trim: true },
    validFrom: { type: Date, default: null },
    validUntil: { type: Date, default: null },
    active: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);
planOfferSchema.index({ plan: 1, cycle: 1, currency: 1 }, { unique: true });

module.exports = mongoose.model('PlanOffer', planOfferSchema);
