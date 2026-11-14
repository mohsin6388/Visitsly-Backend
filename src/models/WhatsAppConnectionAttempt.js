const mongoose = require('mongoose');
const { Schema } = mongoose;

/**
 * Short-lived, tenant-scoped Meta Embedded Signup hand-off.
 * OAuth codes are exchanged once; the resulting token is encrypted at rest so
 * a user can select a phone number / retry a PIN without reopening OAuth.
 */
const schema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  wabaId: { type: String, required: true, trim: true },
  accessTokenEncrypted: { type: String, required: true, select: false },
  phoneNumbers: [{
    _id: false,
    phoneNumberId: { type: String, required: true, trim: true },
    displayPhoneNumber: { type: String, default: null },
    verifiedName: { type: String, default: null },
    qualityRating: { type: String, default: null },
  }],
  selectedPhoneNumberId: { type: String, default: null },
  status: { type: String, enum: ['pending', 'completing'], default: 'pending', index: true },
  expiresAt: { type: Date, required: true },
}, { timestamps: true });

schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
schema.index({ organizationId: 1, createdBy: 1, status: 1 });

module.exports = mongoose.model('WhatsAppConnectionAttempt', schema);
