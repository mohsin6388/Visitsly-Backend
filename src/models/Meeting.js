const mongoose = require('mongoose');
const { Schema } = mongoose;

const meetingSchema = new Schema(
  {
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true, index: true },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    propertyId: { type: Schema.Types.ObjectId, ref: 'Property', default: null },

    preferredDate: { type: String, required: true }, // ISO date (YYYY-MM-DD)
    preferredTime: { type: String, required: true }, // "HH:mm" 24hr

    status: {
      type: String,
      enum: ['scheduled', 'visited', 'not_visited', 'rescheduled', 'cancelled'],
      default: 'scheduled',
    },
    notes: { type: String, default: '' },

    // Where the visit was booked: by the AI inside a WhatsApp chat, or by a broker by hand.
    source: { type: String, enum: ['whatsapp_ai', 'voice_ai', 'manual'], default: 'manual', index: true },
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', default: null },

    // Google Calendar sync — set once the event is booked (see
    // services/calendar/googleCalendarService.js). Null if Calendar isn't
    // configured or the booking call failed.
    googleEventId: { type: String, default: null },
    googleEventLink: { type: String, default: null },

    // WhatsApp visit confirmation (see services/visits/visitConfirmation.js)
    confirmation: {
      status: { type: String, enum: ['none', 'pending', 'confirmed', 'declined'], default: 'none', index: true },
      sentAt: { type: Date, default: null },
      repliedAt: { type: Date, default: null },
      lastAttemptAt: { type: Date, default: null },
      calledAt: { type: Date, default: null }, // AI call confirmation
      callStatus: { type: String, default: null }, // queued / completed / no-answer / busy / failed
      callAttempts: { type: Number, default: 0 },
      callLogId: { type: Schema.Types.ObjectId, ref: 'CallLog', default: null },
      // How the answer came: 'call' (AI voice) or 'whatsapp' (reply / fallback)
      confirmedVia: { type: String, enum: ['call', 'whatsapp', 'manual', null], default: null },
      // WhatsApp message sent because the AI call was not answered
      whatsappFallbackAt: { type: Date, default: null },
      flow: { type: String, enum: ['call_first', 'whatsapp_first', null], default: null },
      error: { type: String, default: null },
    },
  },
  { timestamps: true }
);

meetingSchema.index({ ownerId: 1, status: 1, preferredDate: 1 });
meetingSchema.index({ status: 1, 'confirmation.status': 1, preferredDate: 1 });

module.exports = mongoose.model('Meeting', meetingSchema);
