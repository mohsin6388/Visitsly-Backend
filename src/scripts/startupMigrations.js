const mongoose = require("mongoose");
const logger = require("../utils/logger");
const { withLock } = require("../utils/distributedLock");

/**
 * Small, idempotent data fixes that run once at boot (guarded by a lock and
 * an `app_migrations` record, so several instances never run them twice).
 */
const MIGRATIONS = [
  {
    id: "2026-11-visit-confirm-simple-flow",
    // One simple flow: AI call first (platform voice) with WhatsApp fallback.
    // WhatsApp confirmation is always on; clients can switch AI calling off.
    async run() {
      const Settings = require("../models/Settings");
      const res = await Settings.updateMany({}, { $set: { "visitConfirm.enabled": true, "visitConfirm.callEnabled": true, "visitConfirm.mode": "call_first" } });
      return { modified: res.modifiedCount };
    },
  },
  {
    id: "2026-11-voice-plivo-instant-call",
    // AI calling moved from Bolna to Plivo + ElevenLabs, and the confirmation
    // call now goes out right after booking (old default was 30 min).
    async run() {
      const Settings = require("../models/Settings");
      const Organization = require("../models/Organization");
      const a = await Settings.updateMany({ "visitConfirm.callDelayMinutes": 30 }, { $set: { "visitConfirm.callDelayMinutes": 1 } });
      const b = await Settings.updateMany({ "visitConfirm.callEnabled": { $exists: false } }, { $set: { "visitConfirm.callEnabled": true } });
      const c = await Organization.collection.updateMany(
        { "voice.provider": { $ne: "plivo" } },
        { $set: { "voice.provider": "plivo" }, $unset: { "voice.apiKeyEncrypted": "", "voice.agentId": "", "voice.fromNumber": "" } },
      );
      return { delay: a.modifiedCount, toggle: b.modifiedCount, orgs: c.modifiedCount };
    },
  },
  {
    id: "2026-11-razorpay-plan-currency-index",
    // Plans are now unique per currency; drop the old INR-only unique index.
    async run() {
      const col = mongoose.connection.collection("razorpayplans");
      const indexes = await col.indexes().catch(() => []);
      const old = indexes.find((i) => i.name === "code_1_cycle_1_amountPaise_1");
      if (old) await col.dropIndex(old.name);
      await col.updateMany({ currency: { $exists: false } }, { $set: { currency: "INR" } });
      return { dropped: Boolean(old) };
    },
  },
  {
    id: "2026-11-followups-auto-default",
    // Follow-ups now default to automatic. Companies that never touched the
    // Follow-up setup still had the old stored default ("manual").
    async run() {
      const Settings = require("../models/Settings");
      const res = await Settings.updateMany(
        { "followUp.mode": "manual", "followUp.messages.0": { $exists: false } },
        { $set: { "followUp.mode": "auto" } },
      );
      return { modified: res.modifiedCount };
    },
  },
  {
    id: "2026-11-inbox-preview-backfill",
    // Inbox list now reads a denormalised preview instead of scanning messages.
    async run() {
      const Conversation = require("../models/Conversation");
      const Message = require("../models/Message");
      let done = 0;
      const cursor = Conversation.find({ lastMessageAt: { $ne: null }, $or: [{ lastMessagePreview: "" }, { lastMessagePreview: { $exists: false } }] })
        .select("_id")
        .lean()
        .cursor();
      for await (const c of cursor) {
        const last = await Message.findOne({ conversationId: c._id }).sort({ timestamp: -1 }).select("text type media direction sender timestamp").lean();
        if (!last) continue;
        await Conversation.updateOne(
          { _id: c._id },
          {
            $set: {
              lastMessagePreview: Message.previewOf(last),
              lastMessageDirection: last.direction,
              lastMessageSender: last.sender,
              ...(last.direction === "outbound" ? { lastOutboundAt: last.timestamp } : {}),
            },
          },
        );
        done += 1;
      }
      return { updated: done };
    },
  },
  {
    id: "2026-11-org-opening-template",
    // The opening template is now per organization (Organization.whatsapp).
    // Copy each organization's OWN previous selection from its Settings
    // document. The legacy META_WHATSAPP_OPENING_TEMPLATE_NAME env value is
    // copied ONLY into the organization that was migrated onto the platform's
    // own WhatsApp credentials (connectedVia = "env") - its WABA is the one
    // that template was approved in - and never into any other tenant.
    async run() {
      const orgs = mongoose.connection.collection("organizations");
      const settings = mongoose.connection.collection("settings");
      let fromSettings = 0;
      let fromEnv = 0;
      const cursor = orgs.find({
        $or: [
          { "whatsapp.openingTemplateName": null },
          { "whatsapp.openingTemplateName": { $exists: false } },
        ],
      });
      for await (const org of cursor) {
        const own = await settings.findOne({ orgId: org._id });
        let name = own?.openingTemplate?.name || null;
        let language = own?.openingTemplate?.language || null;
        let via = "settings";
        if (!name && org.whatsapp?.connectedVia === "env") {
          name = process.env.META_WHATSAPP_OPENING_TEMPLATE_NAME || null;
          language = process.env.META_WHATSAPP_OPENING_TEMPLATE_LANGUAGE || "en_US";
          via = "env";
        }
        if (!name) continue;
        await orgs.updateOne(
          { _id: org._id },
          { $set: { "whatsapp.openingTemplateName": name, "whatsapp.openingTemplateLanguage": language || "en_US" } },
        );
        if (via === "env") fromEnv += 1;
        else fromSettings += 1;
      }
      return { fromSettings, fromEnv };
    },
  },
  {
    id: "2026-11-org-profile-done-existing",
    // The onboarding wizard (PATCH /api/org/profile) is for NEW workspaces
    // only. Every company that already exists is marked done so nobody is
    // forced through it. New signups are created with profileDone = false
    // explicitly, so they are never matched here.
    async run() {
      const orgs = mongoose.connection.collection("organizations");
      const res = await orgs.updateMany(
        { "onboarding.profileDone": { $exists: false } },
        { $set: { "onboarding.profileDone": true } },
      );
      return { modified: res.modifiedCount };
    },
  },
  {
    id: "2026-11-grandfather-plan-limits-features",
    // New plan limits (fewer logins / AI chats) and newly enforced feature
    // gates must not cut down any existing paid company. For every company
    // on a paid plan, write limitOverrides equal to the limits it has TODAY
    // (old plan defaults, incl. any <PLAN>_MAX_* env values) for every key
    // the admin hasn't already overridden, and featureOverrides that keep
    // every feature that was available before this release.
    async run() {
      const orgs = mongoose.connection.collection("organizations");
      const { envLimit, OLD_LIMITS, OLD_FEATURES } = grandfatherSnapshot();
      let updated = 0;
      const cursor = orgs.find({ plan: { $in: ["starter", "growth", "builder", "enterprise"] } }).project({ plan: 1, limitOverrides: 1, featureOverrides: 1 });
      for await (const org of cursor) {
        const old = OLD_LIMITS[org.plan];
        if (!old) continue;
        const limitOverrides = { ...(org.limitOverrides || {}) };
        for (const [key, value] of Object.entries(old)) {
          if (Object.prototype.hasOwnProperty.call(limitOverrides, key) && limitOverrides[key] !== undefined && limitOverrides[key] !== "") continue;
          limitOverrides[key] = envLimit(`${org.plan.toUpperCase()}_${ENV_SUFFIX[key]}`, value);
        }
        const featureOverrides = { ...OLD_FEATURES[org.plan], ...(org.featureOverrides || {}) };
        await orgs.updateOne({ _id: org._id }, { $set: { limitOverrides, featureOverrides } });
        updated += 1;
      }
      return { updated };
    },
  },
  {
    id: "2026-11-retired-currencies-to-usd",
    // Only INR, AED and USD are billed now. Companies that still carry a
    // retired currency (SAR, GBP, EUR …) and have no running subscription are
    // moved to their country's currency (IN → INR, AE → AED, else USD).
    // Companies with a live Razorpay subscription keep it until the admin
    // migrates them (renewals continue in the subscription's currency).
    async run() {
      const pricing = require("../config/pricing");
      const orgs = mongoose.connection.collection("organizations");
      let moved = 0;
      let kept = 0;
      const cursor = orgs.find({ currency: { $nin: pricing.SUPPORTED_CURRENCIES } }).project({ country: 1, currency: 1, status: 1, razorpay: 1 });
      for await (const org of cursor) {
        if (org.status === "active" && org.razorpay?.subscriptionId) {
          kept += 1;
          continue;
        }
        await orgs.updateOne({ _id: org._id }, { $set: { currency: pricing.currencyForCountry(org.country || "IN") } });
        moved += 1;
      }
      return { moved, keptWithLiveSubscription: kept };
    },
  },
];

// Env-var suffixes used by config/plans.js (<PLAN>_<SUFFIX>).
const ENV_SUFFIX = {
  users: "MAX_USERS",
  contacts: "MAX_CONTACTS",
  aiConversations: "MAX_AI_CONVERSATIONS",
  whatsappNumbers: "MAX_WHATSAPP_NUMBERS",
  campaignsPerMonth: "MAX_CAMPAIGNS",
  bulkMessages: "MAX_BULK_MESSAGES",
  aiRepliesPerContact: "AI_REPLIES_PER_CONTACT",
};

/** Plan limits and features as they were BEFORE the Nov-2026 pricing change. */
function grandfatherSnapshot() {
  function envLimit(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || String(raw).trim() === "") return fallback;
    const v = String(raw).trim().toLowerCase();
    if (["unlimited", "none", "null", "infinite", "-1"].includes(v)) return null;
    const n = Number.parseInt(v, 10);
    return Number.isInteger(n) && n >= 0 ? n : fallback;
  }
  const OLD_LIMITS = {
    starter: { users: 3, contacts: 5000, aiConversations: 1500, whatsappNumbers: 1, campaignsPerMonth: 30, bulkMessages: null, aiRepliesPerContact: null },
    growth: { users: 8, contacts: 15000, aiConversations: 4000, whatsappNumbers: 1, campaignsPerMonth: null, bulkMessages: null, aiRepliesPerContact: null },
    builder: { users: 20, contacts: 50000, aiConversations: 10000, whatsappNumbers: 2, campaignsPerMonth: null, bulkMessages: null, aiRepliesPerContact: null },
    enterprise: { users: null, contacts: null, aiConversations: null, whatsappNumbers: null, campaignsPerMonth: null, bulkMessages: null, aiRepliesPerContact: null },
  };
  // Before this release every plan could use these (nothing was enforced);
  // the Meta bill dashboard was already Growth+ only.
  const everything = {
    bulkWhatsapp: true,
    emailCampaigns: true,
    teamRouting: true,
    autoFollowUps: true,
    inventory: true,
    multiProjectBot: true,
    metaLeadAds: true,
    weeklyReports: true,
    aiCalling: true,
  };
  const OLD_FEATURES = {
    starter: { ...everything },
    growth: { ...everything },
    builder: { ...everything },
    enterprise: { ...everything },
  };
  return { envLimit, OLD_LIMITS, OLD_FEATURES };
}

async function runStartupMigrations() {
  await withLock("startup-migrations", 30 * 60 * 1000, async () => {
    const col = mongoose.connection.collection("app_migrations");
    for (const m of MIGRATIONS) {
      // eslint-disable-next-line no-await-in-loop
      if (await col.findOne({ _id: m.id })) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        const result = await m.run();
        // eslint-disable-next-line no-await-in-loop
        await col.insertOne({ _id: m.id, ranAt: new Date(), result });
        logger.info(`[migrate] ${m.id} done`, result);
      } catch (err) {
        logger.error(`[migrate] ${m.id} failed (will retry next boot)`, { error: err.message });
      }
    }
  });
}

module.exports = { runStartupMigrations, MIGRATIONS };
