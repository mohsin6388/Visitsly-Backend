const mongoose = require("mongoose");
const { Schema } = mongoose;

/**
 * A paying customer company (tenant) — a broker, agency or builder.
 *
 * All existing CRM records (leads, campaigns, properties, conversations…)
 * keep their `ownerId` field: for SaaS, `ownerId` is the org's
 * `ownerUserId` (the workspace owner), so every teammate of the company
 * reads and writes the same workspace.
 */
const STATUSES = ["trialing", "active", "past_due", "suspended", "cancelled"];

const organizationSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    ownerUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    city: { type: String, trim: true, default: "" },
    businessType: {
      type: String,
      enum: ["broker", "agency", "builder", "other"],
      default: "broker",
    },
    gstin: { type: String, trim: true, default: "" },
    billingEmail: { type: String, trim: true, lowercase: true, default: "" },
    phone: { type: String, trim: true, default: "" },

    // ---- Subscription ----
    plan: {
      type: String,
      enum: ["trial", "starter", "growth", "builder", "enterprise"],
      default: "trial",
    },
    billingCycle: {
      type: String,
      enum: ["monthly", "annual"],
      default: "monthly",
    },
    status: { type: String, enum: STATUSES, default: "trialing", index: true },
    trialEndsAt: { type: Date, default: null },
    currentPeriodEnd: { type: Date, default: null },
    cancelAtPeriodEnd: { type: Boolean, default: false },
    // Plan the customer picked at signup or checkout but hasn't paid for yet.
    pendingPlan: { type: String, default: null },
    pendingCycle: { type: String, default: null },
    razorpay: {
      customerId: { type: String, default: null },
      subscriptionId: { type: String, default: null, index: true },
      planId: { type: String, default: null },
      // Checkout started but not paid yet (kept separate so an active
      // subscription isn't overwritten by an abandoned upgrade attempt).
      pendingSubscriptionId: { type: String, default: null, index: true },
      setupFeePaid: { type: Boolean, default: false },
    },
    // Platform admin can give a customer custom limits (null = unlimited).
    limitOverrides: { type: Schema.Types.Mixed, default: {} },
    // Platform admin can mark special deals (e.g. founding client discount).
    notes: { type: String, default: "" },
    priceOverride: { type: Number, default: null }, // custom monthly price (INR) for this org

    // ---- WhatsApp (Meta Cloud API) — one connected number per org ----
    whatsapp: {
      status: {
        type: String,
        enum: ["not_connected", "connected", "error"],
        default: "not_connected",
      },
      connectedVia: {
        type: String,
        enum: ["embedded_signup", "manual", "env", null],
        default: null,
      },
      phoneNumberId: { type: String, default: null },
      businessAccountId: { type: String, default: null },
      displayPhoneNumber: { type: String, default: null },
      verifiedName: { type: String, default: null },
      qualityRating: { type: String, default: null },
      accessTokenEncrypted: { type: String, default: null, select: false },
      // Opening template chosen by THIS organization (approved in its own WABA).
      openingTemplateName: { type: String, default: null },
      openingTemplateLanguage: { type: String, default: null },
      openingTemplateId: { type: String, default: null },
      openingTemplateCategory: { type: String, default: null },
      // How each {{variable}} of the template is filled for every lead.
      openingTemplateVariables: {
        type: [
          new Schema(
            {
              component: { type: String, enum: ['header', 'body'] },
              key: { type: String },
              source: { type: String, enum: ['name', 'phone', 'email', 'company', 'fixed'] },
              value: { type: String, default: '' },
            },
            { _id: false }
          ),
        ],
        default: [],
      },
      openingTemplateSelectedAt: { type: Date, default: null },
      openingTemplateSelectedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
      connectedAt: { type: Date, default: null },
      lastError: { type: String, default: null },
      lastErrorCode: { type: String, default: null },
      lastErrorStage: { type: String, default: null },
      lastErrorAt: { type: Date, default: null },
      // Last verified delivery activity observed by PropAI's Meta webhook.
      webhookLastReceivedAt: { type: Date, default: null },
      webhookLastMessageAt: { type: Date, default: null },
    },

    // ---- Usage (reset each calendar month, Asia/Kolkata) ----
    usage: {
      month: { type: String, default: null }, // 'YYYY-MM'
      aiConversations: { type: Number, default: 0 },
      messagesSent: { type: Number, default: 0 },
      campaigns: { type: Number, default: 0 },
      emailsSent: { type: Number, default: 0 },
      voiceMinutes: { type: Number, default: 0 },
    },
    // Lifetime count of bulk (campaign) messages sent — WhatsApp + email.
    // NOT reset monthly; the trial's bulk-message limit is checked against this.
    bulkMessagesTotal: { type: Number, default: 0 },

    onboarding: {
      companyDone: { type: Boolean, default: false },
      whatsappDone: { type: Boolean, default: false },
      contactsDone: { type: Boolean, default: false },
      propertiesDone: { type: Boolean, default: false },
      firstMessageDone: { type: Boolean, default: false },
      dismissed: { type: Boolean, default: false },
    },

    suspendedReason: { type: String, default: null },

    // ---- Paid add-ons (set by the PropAI admin after payment) ----
    addons: {
      extraUsers: { type: Number, default: 0 },
      extraNumbers: { type: Number, default: 0 },
      aiPacks: { type: Number, default: 0 }, // each = 1,000 AI conversations / month
    },

    // ---- White-label (Enterprise) ----
    branding: {
      productName: { type: String, default: "" }, // shown instead of "PropAI"
      logoUrl: { type: String, default: "" },
      primaryColor: { type: String, default: "" },
      customDomain: { type: String, default: "", lowercase: true, trim: true }, // e.g. crm.agarwalhomez.com
    },

    // ---- Lead capture (website form, portals, Google Ads, Meta Lead Ads) ----
    leadCapture: {
      key: { type: String, default: null, index: true, sparse: true }, // secret in the inbound URL / forwarding email
      autoWhatsapp: { type: Boolean, default: true }, // send the opening template as soon as a lead arrives
      metaPageId: { type: String, default: null, index: true, sparse: true },
      metaPageName: { type: String, default: null },
      metaPageTokenEncrypted: { type: String, default: null, select: false },
      metaConnectedAt: { type: Date, default: null },
    },

    // ---- Lead routing ----
    routing: {
      mode: { type: String, enum: ["off", "round_robin"], default: "off" },
      agentIds: [{ type: Schema.Types.ObjectId, ref: "User" }], // empty = all active agents/managers
      lastIndex: { type: Number, default: -1 },
      agentsSeeOnlyAssigned: { type: Boolean, default: false },
    },

    // ---- AI voice calling (Bolna) ----
    voice: {
      enabled: { type: Boolean, default: false },
      provider: { type: String, enum: ["bolna"], default: "bolna" },
      apiKeyEncrypted: { type: String, default: null, select: false },
      agentId: { type: String, default: null },
      fromNumber: { type: String, default: null },
      autoCallNewLeads: { type: Boolean, default: false }, // call when a new lead doesn't reply on WhatsApp
      autoCallAfterMinutes: { type: Number, default: 30 },
    },

    // ---- Extra WhatsApp numbers (Builder 2, Enterprise many) ----
    extraNumbers: [
      {
        label: { type: String, default: "" },
        phoneNumberId: { type: String, required: true },
        businessAccountId: { type: String, default: null },
        displayPhoneNumber: { type: String, default: null },
        verifiedName: { type: String, default: null },
        accessTokenEncrypted: { type: String, default: null, select: false },
        connectedAt: { type: Date, default: Date.now },
      },
    ],

    // ---- Channel partner programme (builders) ----
    channelPartners: {
      enabled: { type: Boolean, default: false },
      defaultCommissionPct: { type: Number, default: 2 },
      leadProtectionDays: { type: Number, default: 60 },
      autoApprove: { type: Boolean, default: false },
    },

    // ---- Spend budget (WhatsApp + AI calling) with WhatsApp threshold alerts ----
    budget: {
      enabled: { type: Boolean, default: false },
      amount: { type: Number, default: 0 }, // in `currency`
      currency: { type: String, default: "INR" },
      period: { type: String, enum: ["month", "custom"], default: "month" },
      startDate: { type: String, default: null }, // YYYY-MM-DD (custom)
      endDate: { type: String, default: null }, // YYYY-MM-DD (custom)
      thresholds: { type: [Number], default: () => [50, 80, 100] },
      alertPhone: { type: String, default: null },
      pauseCampaignsAtLimit: { type: Boolean, default: false },
      // Per-unit estimate used when Meta does not return cost (editable).
      rates: {
        marketing: { type: Number, default: 0.88 },
        utility: { type: Number, default: 0.13 },
        authentication: { type: Number, default: 0.13 },
        service: { type: Number, default: 0 },
        voicePerMinute: { type: Number, default: 7 },
      },
      lastAlert: {
        periodKey: { type: String, default: null },
        level: { type: Number, default: 0 },
        at: { type: Date, default: null },
      },
      lastReportAt: { type: Date, default: null },
    },

    // ---- Billing region (set at signup from the chosen country) ----
    country: { type: String, default: "IN" },
    currency: { type: String, default: "INR" },

    // Paid add-ons bought in-app (expire after their period).
    addonGrants: [
      {
        key: { type: String, required: true },
        quantity: { type: Number, default: 1 },
        expiresAt: { type: Date, default: null }, // null = one-time pack (no expiry)
        paymentId: { type: String, default: null },
        createdAt: { type: Date, default: Date.now },
      },
    ],

    weeklyReport: {
      enabled: { type: Boolean, default: false },
      phone: { type: String, default: null },
      lastSentWeek: { type: String, default: null },
    },
  },
  { timestamps: true },
);

organizationSchema.index({ "extraNumbers.phoneNumberId": 1 });
organizationSchema.index(
  { "whatsapp.phoneNumberId": 1 },
  {
    unique: true,
    partialFilterExpression: { "whatsapp.phoneNumberId": { $type: "string" } },
  },
);

organizationSchema.statics.STATUSES = STATUSES;

organizationSchema.statics.slugify = function slugify(name) {
  return (
    String(name || "company")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "company"
  );
};

module.exports = mongoose.model("Organization", organizationSchema);
