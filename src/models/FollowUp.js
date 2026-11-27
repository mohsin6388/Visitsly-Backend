const mongoose = require('mongoose');
const { Schema } = mongoose;

const followUpSchema = new Schema(
  {
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true, index: true },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    nextFollowUpDate: { type: Date, required: true },
    nextFollowUpMessage: { type: String, required: true },
    urgency: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
    buyingProbability: { type: Number, min: 0, max: 100, default: null },

    status: { type: String, enum: ['pending', 'sent', 'done', 'skipped'], default: 'pending' },
    generatedBy: { type: String, default: 'gemini' },

    // Automation: 'ai' = analyzer ne banaya, 'sequence' = no-reply sequence ka step
    kind: { type: String, enum: ['ai', 'sequence', 'reengage', 'manual'], default: 'ai' },
    step: { type: Number, default: 0 }, // sequence me kaunsa follow-up (1,2,3...)
    sentAt: { type: Date, default: null },
    notifiedAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    attempts: { type: Number, default: 0 },
  },
  { timestamps: true }
);

followUpSchema.index({ ownerId: 1, status: 1, nextFollowUpDate: 1 });

module.exports = mongoose.model('FollowUp', followUpSchema);
