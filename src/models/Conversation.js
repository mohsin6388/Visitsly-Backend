const mongoose = require("mongoose");
const { Schema } = mongoose;

const conversationSchema = new Schema(
  {
    leadId: {
      type: Schema.Types.ObjectId,
      ref: "Lead",
      required: true,
      unique: true,
    },
    ownerId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // Meta WhatsApp Cloud API has no per-thread "chat id" the way Unipile
    // did — every send just targets the lead's phone number directly, so
    // there's nothing to store here anymore. Whether the very first
    // (business-initiated) template message has gone out is tracked instead
    // via `templateSent` below, which is what actually matters for the 24h
    // customer-service-window rule.
    templateSent: { type: Boolean, default: false },
    templateSentAt: { type: Date, default: null },

    status: {
      type: String,
      enum: ["ai_active", "manual", "paused", "closed"],
      default: "ai_active",
    },

    lastMessageAt: { type: Date, default: null, index: true },
    // The WhatsApp 24-hour customer-service window is based on the lead's
    // last INBOUND message, not our last outbound message.
    lastInboundAt: { type: Date, default: null, index: true },
    unreadCount: { type: Number, default: 0 },

    aiSummary: { type: String, default: "" },
    // SaaS billing: 'YYYY-MM' of the last month this chat was counted as one
    // AI conversation against the company's plan quota.
    aiBilledMonth: { type: String, default: null },
    // How many replies the AI has sent to this contact (plan cap: aiRepliesPerContact).
    aiReplyCount: { type: Number, default: 0 },
    // Set when the per-contact cap was hit (used to notify the owner only once).
    aiLimitReachedAt: { type: Date, default: null },
    // Which of the company's WhatsApp numbers this buyer talks to (multi-number plans).
    phoneNumberId: { type: String, default: null },
    assignedTo: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    currentLeadScore: { type: Number, default: 0 },

    collectedRequirements: {
      budgetMin: { type: Number, default: null },
      budgetMax: { type: Number, default: null },
      city: { type: String, default: null },
      bhk: { type: String, default: null },
      propertyType: { type: String, default: null },
      extra: { type: Schema.Types.Mixed, default: {} }, // AI ke naye/unstructured fields yahin
    },
    requirementsComplete: { type: Boolean, default: false },

    lastIntent: { type: String, default: null },
    lastSentiment: { type: String, default: null },

    recommendedProperties: [{ type: Schema.Types.ObjectId, ref: "Property" }],

    meetingStatus: {
      type: String,
      enum: [
        "none",
        "proposed",
        "scheduled",
        "visited",
        "not_visited",
        "cancelled",
      ],
      default: "none",
    },

    // Closing-step referral/handoff ("kya aap Monica ko apne kaam ke liye
    // lena chahenge?"), asked once the property conversation looks
    // wrapped-up and the lead seems satisfied. Guarded here so the AI never
    // asks twice and the phone number is only ever sent once, by the code
    // (never generated freeform by the AI — see conversationEngine.js).
    referralStatus: {
      type: String,
      enum: ["none", "asked", "accepted", "declined"],
      default: "none",
    },
    referralAskedAt: { type: Date, default: null },
    referralRespondedAt: { type: Date, default: null },

    tags: [{ type: String, trim: true }],

    // ---- Inbox list (denormalised so the list never scans Messages) ----
    lastMessagePreview: { type: String, default: "" },
    lastMessageDirection: { type: String, enum: ["inbound", "outbound", null], default: null },
    lastMessageSender: { type: String, default: null },
    lastOutboundAt: { type: Date, default: null },

    // ---- AI memory ----
    // Language the customer chose; the AI must keep using it until the
    // customer explicitly asks to switch (see conversationEngine.js).
    language: { type: String, default: null },
    languageLockedAt: { type: Date, default: null },
    // Rolling long-term memory, refreshed by the lead analyser. Sent to the
    // model on every turn so a buyer who comes back after days is remembered.
    memory: { type: String, default: "" },

    // ---- Opt-out / decline handling ----
    // Customer said "STOP / unsubscribe / block" → never message again (Meta policy).
    optedOut: { type: Boolean, default: false },
    optedOutAt: { type: Date, default: null },
    // Customer said "not interested / abhi nahi" → gentle re-follow-up later.
    declinedAt: { type: Date, default: null },
    declineCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

conversationSchema.index({ ownerId: 1, status: 1, lastMessageAt: -1 });
conversationSchema.index({ ownerId: 1, lastMessageAt: -1 });
conversationSchema.index({ ownerId: 1, unreadCount: 1, lastMessageAt: -1 });

module.exports = mongoose.model("Conversation", conversationSchema);
