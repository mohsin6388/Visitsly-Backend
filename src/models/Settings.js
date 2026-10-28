const mongoose = require('mongoose');
const { Schema } = mongoose;

const settingsSchema = new Schema(
  {
    // One Settings document per company (tenant). A legacy single-client
    // document has no orgId until the migration script attaches it.
    orgId: { type: Schema.Types.ObjectId, ref: 'Organization', default: null, index: { unique: true, sparse: true } },

    companyName: { type: String, default: '', trim: true },
    logoUrl: { type: String, default: '' },

    // Encrypted at rest via app-level encryption (see utils/crypto in a later phase);
    // never returned to the client in plaintext.
    geminiApiKeyEncrypted: { type: String, default: null, select: false },

    businessHours: {
      start: { type: String, default: '09:00' },
      end: { type: String, default: '19:00' },
    },
    workingDays: {
      type: [String],
      default: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    },
    greetingMessage: {
      type: String,
      default: "Hi! Thanks for your interest. I'm here to help you find the right property 🙂",
    },

    // Message used when a lead is added while its WhatsApp 24-hour customer
    // service window is already open. If blank, the env fallback or
    // greetingMessage is used.
    openingText: {
      type: String,
      default: "",
      trim: true,
    },

    aiPaused: { type: Boolean, default: false },
    autoReplyEnabled: { type: Boolean, default: true },

    // Alert the broker/team number when AI scores a lead as hot (default) or warm/hot.
    leadAlertPhone: { type: String, default: null, trim: true },
    leadAlertLevel: { type: String, enum: ['hot', 'hot_warm'], default: 'hot' },

    // Seconds the AI waits before sending its reply, kept for backwards-
    // compatibility with existing Settings documents/Settings page UI.
    // NOT strictly enforced anymore — conversationEngine.js sends every
    // reply with a fixed randomized 3-4s delay regardless of this value,
    // so it no longer needs (or should have) a narrow enum. A narrow enum
    // here was a bug: Mongoose validates the ENTIRE document on every
    // .save() call (e.g. from the Settings page, or the daily-report
    // scheduler), so any org whose stored value was the old default (5)
    // or another old option (2/10) would fail EVERY settings save with a
    // validation error the moment the enum was narrowed to [3,4].
    aiReplyDelaySeconds: { type: Number, min: 1, max: 30, default: 4 },

    // "Human Takeover" (Settings page toggle) is just a friendlier name for
    // aiPaused — kept as the same field so every place that already checks
    // settings.aiPaused (conversationEngine, etc.) keeps working unchanged.

    // Org-level WhatsApp disconnect switch. The Meta WhatsApp Cloud API
    // connection is shared infra (one META_WHATSAPP_PHONE_NUMBER_ID per
    // deployment), so "Disconnect" here doesn't touch that connection — it
    // stops THIS org's AI/manual sends and inbound auto-replies until
    // reconnected.
    whatsappDisconnected: { type: Boolean, default: false },

    // Daily WhatsApp summary — "today we talked to N leads, here are the
    // interested ones with name+phone" sent to a fixed WhatsApp number
    // every day at a configured time (broker's own number, a team lead's
    // number, a group, etc — whatever the connected WhatsApp number can
    // message). Time is HH:mm 24-hour, evaluated in Asia/Kolkata.
    dailyReportEnabled: { type: Boolean, default: false },
    dailyReportPhone: { type: String, default: null, trim: true },
    dailyReportTime: { type: String, default: '19:00' }, // HH:mm, 24hr

    // Internal bookkeeping so the once-a-minute scheduler doesn't send the
    // same day's report twice (e.g. if the server restarts right at 19:00
    // or the cron tick overlaps). Not meant to be set from the API.
    dailyReportLastSentDate: { type: String, default: null, select: false }, // 'YYYY-MM-DD'

    // Human handoff / referral closing step — "kya aap Monica ko apne kaam
    // ke liye lena chahenge?" asked once a property conversation winds down
    // and the lead seems satisfied. DB values here always win over the
    // REFERRAL_* env var fallbacks (see config/env.js). contactNumber is the
    // number actually sent to the lead once they say yes — kept out of the
    // AI's hands on purpose (see conversationEngine.js), so this is the one
    // place that controls it.
    referral: {
      enabled: { type: Boolean, default: true },
      personName: { type: String, default: 'Monica', trim: true },
      contactNumber: { type: String, default: null, trim: true },
    },

    // Which approved WhatsApp message TEMPLATE opens a brand-new
    // conversation (the very first, business-initiated message to a lead —
    // required by Meta's WhatsApp Cloud API, see metaWhatsappClient.js).
    // Falls back to META_WHATSAPP_OPENING_TEMPLATE_NAME/LANGUAGE from the
    // environment when left blank here.
    openingTemplate: {
      name: { type: String, default: null, trim: true },
      language: { type: String, default: null, trim: true },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Settings', settingsSchema);
