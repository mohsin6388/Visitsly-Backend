const mongoose = require('mongoose');
const { Schema } = mongoose;

/** Customer → PropAI requests: add-ons, Enterprise enquiry, white-label, support. */
const platformRequestSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    type: { type: String, enum: ['addon', 'enterprise', 'white_label', 'voice', 'support', 'other'], default: 'other' },
    addon: { type: String, default: null }, // extraUser | extraNumber | extraAiConversations | voiceMinute | leadRevival
    quantity: { type: Number, default: 1 },
    message: { type: String, default: '' },
    status: { type: String, enum: ['open', 'done', 'rejected'], default: 'open', index: true },
    adminNote: { type: String, default: '' },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('PlatformRequest', platformRequestSchema);
