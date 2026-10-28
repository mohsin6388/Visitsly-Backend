const mongoose = require('mongoose');
const { Schema } = mongoose;

/** Razorpay plan ids created on demand, one per (plan, cycle, amount). */
const razorpayPlanSchema = new Schema(
  {
    code: { type: String, required: true },
    cycle: { type: String, enum: ['monthly', 'annual'], required: true },
    amountPaise: { type: Number, required: true },
    planId: { type: String, required: true },
  },
  { timestamps: true }
);
razorpayPlanSchema.index({ code: 1, cycle: 1, amountPaise: 1 }, { unique: true });

module.exports = mongoose.model('RazorpayPlan', razorpayPlanSchema);
