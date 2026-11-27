const os = require("os");
const crypto = require("crypto");
const mongoose = require("mongoose");
const logger = require("./logger");

/**
 * Tiny MongoDB-backed lock so background schedulers (follow-ups, visit
 * confirmation, reports, budget alerts …) run on ONE server at a time when the
 * API is scaled to several instances behind a load balancer. Without it every
 * instance would send the same follow-up / confirmation message.
 *
 * withLock(name, ttlMs, fn) → runs fn only if this instance got the lock.
 */
const INSTANCE_ID = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString("hex")}`;

function collection() {
  return mongoose.connection.collection("scheduler_locks");
}

async function acquire(name, ttlMs) {
  const now = new Date();
  try {
    const res = await collection().findOneAndUpdate(
      { _id: name, $or: [{ lockedUntil: { $lt: now } }, { owner: INSTANCE_ID }] },
      { $set: { lockedUntil: new Date(now.getTime() + ttlMs), owner: INSTANCE_ID, at: now } },
      { upsert: true, returnDocument: "after" },
    );
    const doc = res?.value !== undefined ? res.value : res;
    return doc?.owner === INSTANCE_ID;
  } catch (err) {
    if (err.code === 11000) return false; // another instance holds it
    throw err;
  }
}

async function release(name) {
  await collection()
    .updateOne({ _id: name, owner: INSTANCE_ID }, { $set: { lockedUntil: new Date(0) } })
    .catch(() => {});
}

async function withLock(name, ttlMs, fn) {
  if (mongoose.connection.readyState !== 1) return undefined;
  let got = false;
  try {
    got = await acquire(name, ttlMs);
  } catch (err) {
    logger.warn(`[lock] could not acquire ${name}`, { error: err.message });
    return undefined;
  }
  if (!got) return undefined;
  try {
    return await fn();
  } finally {
    await release(name);
  }
}

module.exports = { withLock, INSTANCE_ID };
