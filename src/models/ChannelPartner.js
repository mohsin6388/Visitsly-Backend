const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { Schema } = mongoose;

/** External broker who brings buyers to a builder (company) for commission. */
const channelPartnerSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true }, // company workspace
    name: { type: String, required: true, trim: true },
    firmName: { type: String, trim: true, default: '' },
    phone: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    city: { type: String, trim: true, default: '' },
    reraNumber: { type: String, trim: true, default: '' },
    passwordHash: { type: String, required: true, select: false },
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'suspended'], default: 'pending', index: true },
    commissionPct: { type: Number, default: null }, // null = company default
    lastLoginAt: { type: Date, default: null },
    tokenVersion: { type: Number, default: 0 },
  },
  { timestamps: true }
);

channelPartnerSchema.index({ orgId: 1, email: 1 }, { unique: true });
channelPartnerSchema.index({ orgId: 1, phone: 1 }, { unique: true });

channelPartnerSchema.methods.setPassword = async function setPassword(plain) {
  this.passwordHash = await bcrypt.hash(plain, 12);
};
channelPartnerSchema.methods.comparePassword = function comparePassword(plain) {
  return bcrypt.compare(plain, this.passwordHash);
};

module.exports = mongoose.model('ChannelPartner', channelPartnerSchema);
