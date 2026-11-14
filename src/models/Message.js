const mongoose = require('mongoose');
const { Schema } = mongoose;

/**
 * One WhatsApp message in a conversation (inbound or outbound).
 *
 * Media (photo / video / audio / PDF / sticker / location) is stored as
 * metadata only: `media.id` is Meta's media id (valid ~30 days) and
 * `media.url` is a permanent copy (Cloudinary) when storage is configured.
 * The CRM never stores Meta's short-lived download URL.
 */
const mediaSchema = new Schema(
  {
    id: { type: String, default: null }, // Meta media id
    url: { type: String, default: null }, // permanent copy (Cloudinary) or public link we sent
    mimeType: { type: String, default: null },
    filename: { type: String, default: null },
    caption: { type: String, default: null },
    size: { type: Number, default: null },
    sha256: { type: String, default: null },
    // location messages
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
    address: { type: String, default: null },
  },
  { _id: false }
);

const messageSchema = new Schema(
  {
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true, index: true },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true, index: true },

    direction: { type: String, enum: ['inbound', 'outbound'], required: true },
    sender: { type: String, enum: ['ai', 'broker', 'customer'], required: true },

    // Always a human-readable line (caption or "[Photo]") so lists, AI history
    // and exports keep working for media messages too.
    text: { type: String, default: '' },

    type: {
      type: String,
      enum: ['text', 'image', 'video', 'audio', 'document', 'sticker', 'location', 'contacts', 'template', 'interactive', 'reaction', 'unknown'],
      default: 'text',
    },
    media: { type: mediaSchema, default: null },

    // Optional link to the durable outreach job that caused this outbound send.
    // Allows campaign retries/restarts to avoid duplicating a previously stored send.
    outboundJobId: { type: Schema.Types.ObjectId, ref: 'OutboundJob', default: null },

    // Set for messages that actually traversed WhatsApp; used for de-duplicating
    // webhook retries. Sparse+unique so it's only enforced when present.
    whatsappMessageId: { type: String, default: null },

    // Meta accepts a send first and later reports delivered/read/failed via
    // webhook status events. Keep that lifecycle on the message record.
    status: { type: String, enum: ['pending', 'sent', 'delivered', 'read', 'failed'], default: 'sent' },
    errorCode: { type: String, default: null },
    errorMessage: { type: String, default: null },

    // AI trace fields - populated only for AI-generated outbound messages
    aiPrompt: { type: String, default: null, select: false },
    aiResponseRaw: { type: Schema.Types.Mixed, default: null, select: false },
    intent: { type: String, default: null },
    sentiment: { type: String, default: null },

    timestamp: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

messageSchema.index({ conversationId: 1, timestamp: -1 });
messageSchema.index({ outboundJobId: 1 }, { unique: true, partialFilterExpression: { outboundJobId: { $type: 'objectId' } } });
messageSchema.index({ whatsappMessageId: 1 }, { unique: true, sparse: true });
messageSchema.index({ leadId: 1, direction: 1, timestamp: -1 });

/** Short preview line for the inbox list. */
messageSchema.statics.previewOf = function previewOf(msg) {
  const label = {
    image: '📷 Photo',
    video: '🎥 Video',
    audio: '🎤 Voice note',
    document: '📄 Document',
    sticker: 'Sticker',
    location: '📍 Location',
    contacts: '👤 Contact',
  }[msg?.type];
  const caption = msg?.media?.caption || '';
  if (label) return caption ? `${label}: ${caption}`.slice(0, 140) : label;
  return String(msg?.text || '').replace(/\s+/g, ' ').slice(0, 140);
};

module.exports = mongoose.model('Message', messageSchema);
