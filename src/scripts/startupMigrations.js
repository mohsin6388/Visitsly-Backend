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
