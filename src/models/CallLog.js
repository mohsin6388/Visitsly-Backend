const mongoose = require('mongoose');
const { Schema } = mongoose;

/** One AI voice call to a lead (Bolna execution). */
const callLogSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true, index: true },
    provider: { type: String, default: 'bolna' },
    executionId: { type: String, index: true, sparse: true },
    trigger: { type: String, enum: ['manual', 'auto_new_lead'], default: 'manual' },
    status: { type: String, default: 'queued' }, // queued → initiated → ringing → in-progress → completed / failed / no-answer / busy
    durationSec: { type: Number, default: 0 },
    billedMinutes: { type: Number, default: 0 },
    cost: { type: Number, default: null }, // provider cost (their currency)
    recordingUrl: { type: String, default: null },
    transcript: { type: String, default: '' },
    summary: { type: String, default: '' },
    extracted: { type: Schema.Types.Mixed, default: {} },
    interested: { type: Boolean, default: null },
    visitBooked: { type: Boolean, default: false },
    error: { type: String, default: null },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('CallLog', callLogSchema);
