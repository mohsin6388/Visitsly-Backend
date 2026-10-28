require("dotenv").config();
const tenantContext = require("../context/tenantContext");

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const env = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: parseInt(process.env.PORT || "5000", 10),
  clientUrl: process.env.CLIENT_URL || "http://localhost:5173",
  // Separate PropAI admin panel (its own app, its own login).
  adminUrl: process.env.ADMIN_URL || "http://localhost:5174",
  // Extra allowed browser origins, comma-separated.
  extraOrigins: String(process.env.CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean),
  // When set, only this account may authenticate in the single-client deployment.
  // Legacy single-client lock. Ignored in SaaS mode (the default).
  clientEmail: process.env.SAAS_MODE === "false" ? String(process.env.CLIENT_EMAIL || '').trim().toLowerCase() : "",

  saas: {
    enabled: process.env.SAAS_MODE !== "false",
    productName: process.env.PRODUCT_NAME || "PropAI",
    // Comma-separated emails that are always platform super-admins.
    superAdminEmails: String(process.env.SUPER_ADMIN_EMAILS || "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
    signupEnabled: process.env.SIGNUP_ENABLED !== "false",
    salesPhone: process.env.SALES_PHONE || "",
    salesEmail: process.env.SALES_EMAIL || "",
  },

  // Razorpay Subscriptions (https://razorpay.com/docs/api/payments/subscriptions/)
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID || null,
    keySecret: process.env.RAZORPAY_KEY_SECRET || null,
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || null,
  },

  mongoUri: required("MONGO_URI", "mongodb://127.0.0.1:27017/real_estate_crm"),

  jwt: {
    // Admin panel tokens use their own secrets so a customer token can never open it.
    adminAccessSecret: process.env.ADMIN_JWT_ACCESS_SECRET || `${process.env.JWT_ACCESS_SECRET || "dev_access_secret_change_me"}::admin`,
    adminRefreshSecret: process.env.ADMIN_JWT_REFRESH_SECRET || `${process.env.JWT_REFRESH_SECRET || "dev_refresh_secret_change_me"}::admin`,
    accessSecret: required("JWT_ACCESS_SECRET", "dev_access_secret_change_me"),
    refreshSecret: required(
      "JWT_REFRESH_SECRET",
      "dev_refresh_secret_change_me",
    ),
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || "8h",
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "90d",
  },

  cookie: {
    secure: process.env.COOKIE_SECURE === "true",
    sameSite: process.env.COOKIE_SAME_SITE || (process.env.COOKIE_SECURE === "true" ? "none" : "lax"),
    domain: process.env.COOKIE_DOMAIN || undefined,
  },

  resetTokenExpiresMin: parseInt(
    process.env.RESET_TOKEN_EXPIRES_MIN || "30",
    10,
  ),
  emailVerificationExpiresHours: Math.min(72, Math.max(1, parseInt(process.env.EMAIL_VERIFICATION_EXPIRES_HOURS || "24", 10) || 24)),
  disposableEmailDomains: String(process.env.DISPOSABLE_EMAIL_DOMAINS || "")
    .split(",")
    .map((domain) => domain.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean),
  appBaseUrl: process.env.APP_BASE_URL || "http://localhost:5173",

  brevo: {
    apiKey: process.env.BREVO_API_KEY || null,
    fromEmail: String(process.env.BREVO_FROM_EMAIL || "").trim(),
    fromName: String(process.env.BREVO_FROM_NAME || "PropAI").trim(),
    replyTo: String(process.env.EMAIL_REPLY_TO || "").trim(),
    // Brevo inbound parsing uses a dedicated receiving subdomain, separate
    // from the sending domain (for example replies.yourcompany.com).
    inboundDomain: String(process.env.EMAIL_INBOUND_DOMAIN || process.env.BREVO_INBOUND_DOMAIN || "").trim().toLowerCase(),
    webhookSecret: process.env.BREVO_WEBHOOK_SECRET || null,
    replyWindowHours: parseInt(process.env.EMAIL_REPLY_WINDOW_HOURS || "72", 10),
  },

  gemini: {
    apiKey: process.env.GEMINI_API_KEY || null,
    model: process.env.GEMINI_MODEL || "gemini-2.0-flash",
  },
  encryptionKey:
    process.env.ENCRYPTION_KEY || "dev_encryption_key_change_me_in_prod",

  // Meta WhatsApp Cloud API (official, approved WhatsApp Business Platform)
  // — replaces the old Unipile integration entirely. Get these from
  // https://developers.facebook.com -> your App -> WhatsApp -> API Setup:
  //   - phoneNumberId: the "Phone number ID" (NOT the phone number itself)
  //   - businessAccountId: the WhatsApp Business Account (WABA) ID
  //   - accessToken: a PERMANENT token (System User token with
  //     whatsapp_business_messaging + whatsapp_business_management scopes —
  //     the temporary 24h token from the API Setup page is only for testing)
  //   - verifyToken: any string YOU choose, entered again when you register
  //     the webhook in the Meta App Dashboard (Webhooks -> WhatsApp Business
  //     Account -> Verify and Save) — used only for the one-time GET handshake
  //   - appSecret: your Meta App's "App Secret" (App Dashboard -> Settings ->
  //     Basic) — optional but recommended, used to verify that inbound
  //     webhook POSTs really came from Meta (X-Hub-Signature-256 header)
  metaWhatsapp: {
    appId: process.env.META_APP_ID || null,
    // Embedded Signup configuration id (Meta App -> Facebook Login for
    // Business -> Configurations). Needed for the "Connect WhatsApp" button.
    embeddedSignupConfigId: process.env.META_ES_CONFIG_ID || null,
    // Optional partner solution ID for Meta Embedded Signup v4 configurations.
    embeddedSignupSolutionId: process.env.META_ES_SOLUTION_ID || null,
    accessToken: process.env.META_WHATSAPP_ACCESS_TOKEN || null,
    phoneNumberId: process.env.META_WHATSAPP_PHONE_NUMBER_ID || null,
    businessAccountId: process.env.META_WHATSAPP_BUSINESS_ACCOUNT_ID || null,
    apiVersion: process.env.META_WHATSAPP_API_VERSION || "v26.0",
    verifyToken: process.env.META_WHATSAPP_VERIFY_TOKEN || null,
    appSecret: process.env.META_WHATSAPP_APP_SECRET || null,
    autoSubscribe: process.env.META_WHATSAPP_AUTO_SUBSCRIBE !== "false",
    forwardSecret: process.env.META_WHATSAPP_FORWARD_SECRET || null,

    // The very FIRST message to a lead (before they've ever messaged us) can
    // only legally be an approved message TEMPLATE — Meta blocks free-text
    // business-initiated messages outside the 24h customer service window.
    // Get this name/language exactly as approved in Meta Business Manager ->
    // WhatsApp Manager -> Message Templates.
    openingTemplateName:
      process.env.META_WHATSAPP_OPENING_TEMPLATE_NAME || null,
    openingTemplateLanguage:
      process.env.META_WHATSAPP_OPENING_TEMPLATE_LANGUAGE || "en_US",
    openingTemplateIncludeLeadName:
      process.env.META_WHATSAPP_OPENING_TEMPLATE_INCLUDE_LEAD_NAME === "true",
    // Used when the lead's WhatsApp 24-hour customer-service window is already open.
    // In that case we can send ordinary text immediately; no template is needed.
    openingText: process.env.META_WHATSAPP_OPENING_TEXT || "",
    defaultCountryCode: process.env.META_WHATSAPP_DEFAULT_COUNTRY_CODE || "91",
  },

  // Inbound WhatsApp messages from numbers that don't match any existing
  // Lead (i.e. someone messaged the connected WhatsApp number first, before
  // ever being imported/added as a lead) get auto-created as a new Lead so
  // the AI can respond to them too. This is the broker/user account that
  // "owns" the single connected WhatsApp number for this deployment — set
  // it to that broker's User._id. If left unset, the app falls back to the
  // first admin/broker user it finds (logged once at startup-time use).
  leads: {
    defaultOwnerId: process.env.DEFAULT_LEAD_OWNER_ID || null,
  },

  // Human-handoff / referral step at the end of a satisfied property
  // conversation ("kya aap Monica ko apne kaam ke liye lena chahenge?").
  // These are just fallback defaults — the same fields are editable from the
  // Settings page (see Settings model) and DB values always win over these.
  referral: {
    enabled: process.env.REFERRAL_ENABLED !== "false",
    personName: process.env.REFERRAL_PERSON_NAME || "Monica",
    contactNumber: process.env.REFERRAL_CONTACT_NUMBER || null,
  },

  // Google Calendar — used to create the actual calendar event once the AI
  // confirms a site visit with a lead. Auth is via a Service Account (no
  // per-user OAuth dance needed): share the target calendar with the
  // service account's email as "Make changes to events".
  googleCalendar: {
    clientEmail: process.env.GOOGLE_CLIENT_EMAIL || null,
    privateKey:
      (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n") || null,
    calendarId: process.env.GOOGLE_CALENDAR_ID || "primary",
    timezone: process.env.GOOGLE_CALENDAR_TIMEZONE || "Asia/Kolkata",
    defaultDurationMin: parseInt(
      process.env.GOOGLE_CALENDAR_EVENT_DURATION_MIN || "45",
      10,
    ),
  },

  rateLimit: {
    windowMin: parseInt(process.env.RATE_LIMIT_WINDOW_MIN || "15", 10),
    max: parseInt(process.env.RATE_LIMIT_MAX || "300", 10),
    authMax: parseInt(process.env.AUTH_RATE_LIMIT_MAX || "20", 10),
  },
};

/*
 * Multi-tenant WhatsApp: `env.metaWhatsapp` is read in ~100 places. Instead of
 * threading an org through all of them, the getter below returns the
 * CURRENT tenant's credentials (from tenantContext) merged over the
 * platform-level values (app id/secret, verify token, API version).
 *
 * Inside a tenant whose WhatsApp isn't connected yet, token/number are null
 * — so one company can never send through another company's (or the
 * platform's) number. Outside any tenant (startup checks, legacy single
 * client) the plain env values are returned.
 */
const platformMeta = env.metaWhatsapp;
Object.defineProperty(env, "metaWhatsapp", {
  enumerable: true,
  get() {
    const org = tenantContext.getOrg();
    if (!org || !env.saas.enabled) return platformMeta;
    const wa = org.whatsapp || {};
    // Multi-number plans: a chat / campaign may pin one of the extra numbers.
    const override = tenantContext.numberOverride();
    if (override && override !== wa.phoneNumberId) {
      const extra = (org.extraNumbers || []).find((n) => n.phoneNumberId === override);
      if (extra) {
        return {
          ...platformMeta,
          accessToken: extra.accessToken || wa.accessToken || null,
          phoneNumberId: extra.phoneNumberId,
          businessAccountId: extra.businessAccountId || wa.businessAccountId || null,
          openingTemplateName: wa.openingTemplateName || null,
          openingTemplateLanguage: wa.openingTemplateLanguage || platformMeta.openingTemplateLanguage,
          openingText: "",
        };
      }
    }
    if (wa.connectedVia === "env") return platformMeta; // migrated single-client org
    return {
      ...platformMeta,
      accessToken: wa.accessToken || null,
      phoneNumberId: wa.phoneNumberId || null,
      businessAccountId: wa.businessAccountId || null,
      openingTemplateName: wa.openingTemplateName || null,
      openingTemplateLanguage: wa.openingTemplateLanguage || platformMeta.openingTemplateLanguage,
      openingText: "",
    };
  },
});
env.platformMeta = platformMeta;

module.exports = env;
