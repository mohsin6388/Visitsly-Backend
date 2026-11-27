const mongoose = require('mongoose');
const { Schema } = mongoose;

/** One AI voice call to a lead (Plivo call, ElevenLabs voice, Gemini/Groq brain). */
const callLogSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', default: null, index: true }, // null only for test calls
    meetingId: { type: Schema.Types.ObjectId, ref: 'Meeting', default: null, index: true }, // visit confirmation call
    provider: { type: String, default: 'plivo' },
    language: { type: String, default: null }, // voice language used for this call (hi / en / ar …)
    executionId: { type: String, index: true, sparse: true }, // Plivo request_uuid
    callUuid: { type: String, index: true, sparse: true }, // Plivo CallUUID (set when answered / hung up)
    toNumber: { type: String, default: null },
    fromNumber: { type: String, default: null },
    purpose: { type: String, enum: ['visit_confirmation', 'visit_reminder', 'enquiry', 'test'], default: 'enquiry' },
    // Conversation on the call
    context: { type: Schema.Types.Mixed, default: {} }, // what the agent knows (lead, visit, language…)
    turns: [{ _id: false, role: { type: String, enum: ['agent', 'customer'] }, text: String, at: { type: Date, default: Date.now } }],
    noInputCount: { type: Number, default: 0 },
    answeredAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    hangupCause: { type: String, default: null },
    outcome: { type: String, enum: ['confirmed', 'declined', 'reschedule', 'follow_up', 'callback_later', 'not_interested', 'unclear', null], default: null },
    outcomeAppliedAt: { type: Date, default: null },
    finalizedAt: { type: Date, default: null },
    trigger: { type: String, enum: ['manual', 'auto_new_lead', 'visit_confirmation', 'visit_reminder', 'bulk', 'test'], default: 'manual', index: true },
    status: { type: String, default: 'queued' }, // queued → in-progress → completed / failed / no-answer / busy / canceled
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
    // Why the WhatsApp message after this call could not be sent (e.g. 24h window closed, no template).
    whatsappNote: { type: String, default: null },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('CallLog', callLogSchema);
