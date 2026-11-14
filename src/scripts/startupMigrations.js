const mongoose = require("mongoose");
const logger = require("../utils/logger");
const { withLock } = require("../utils/distributedLock");

/**
 * Small, idempotent data fixes that run once at boot (guarded by a lock and
 * an `app_migrations` record, so several instances never run them twice).
 */
const MIGRATIONS = [
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
];

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

module.exports = { runStartupMigrations };
