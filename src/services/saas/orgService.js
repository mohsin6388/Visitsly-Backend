const Organization = require("../../models/Organization");
const { decrypt } = require("../../utils/crypto");
const tenantContext = require("../../context/tenantContext");
const logger = require("../../utils/logger");

/**
 * Loads organizations as plain, cache-friendly snapshots (decrypted WhatsApp
 * token included) and runs work inside a tenant context.
 */
const CACHE_MS = 30 * 1000;
const byId = new Map(); // orgId -> { at, snap }
const ownerToOrg = new Map(); // ownerUserId -> orgId
const phoneToOrg = new Map(); // phoneNumberId -> orgId

function currentMonthIST(date = new Date()) {
  const ist = new Date(date.getTime() + 330 * 60 * 1000);
  return ist.toISOString().slice(0, 7);
}

function snapshot(doc) {
  if (!doc) return null;
  const o = typeof doc.toObject === "function" ? doc.toObject() : { ...doc };
  const wa = { ...(o.whatsapp || {}) };
  wa.accessToken = wa.accessTokenEncrypted
    ? decrypt(wa.accessTokenEncrypted)
    : null;
  delete wa.accessTokenEncrypted;
  const extraNumbers = (o.extraNumbers || []).map((n) => {
    const x = {
      ...n,
      _id: n._id ? String(n._id) : undefined,
      accessToken: n.accessTokenEncrypted
        ? decrypt(n.accessTokenEncrypted)
        : null,
    };
    delete x.accessTokenEncrypted;
    return x;
  });
  if (o.leadCapture) {
    o.leadCapture = { ...o.leadCapture };
    delete o.leadCapture.metaPageTokenEncrypted;
  }
  if (o.voice) {
    o.voice = { ...o.voice };
    delete o.voice.apiKeyEncrypted;
  }
  return {
    ...o,
    extraNumbers,
    _id: String(o._id),
    ownerUserId: String(o.ownerUserId),
    whatsapp: wa,
  };
}

function remember(snap) {
  byId.set(snap._id, { at: Date.now(), snap });
  ownerToOrg.set(snap.ownerUserId, snap._id);
  if (snap.whatsapp?.phoneNumberId)
    phoneToOrg.set(snap.whatsapp.phoneNumberId, snap._id);
  for (const n of snap.extraNumbers || [])
    phoneToOrg.set(n.phoneNumberId, snap._id);
  return snap;
}

function invalidate(orgId) {
  if (!orgId) return;
  const key = String(orgId);
  const cached = byId.get(key);
  if (cached?.snap?.whatsapp?.phoneNumberId)
    phoneToOrg.delete(cached.snap.whatsapp.phoneNumberId);
  byId.delete(key);
}

async function getSnapshot(orgId, { fresh = false } = {}) {
  if (!orgId) return null;
  const key = String(orgId);
  const cached = byId.get(key);
  if (!fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.snap;
  const doc = await Organization.findById(key)
    .select("+whatsapp.accessTokenEncrypted +extraNumbers.accessTokenEncrypted")
    .lean();
  if (!doc) return null;
  return remember(snapshot(doc));
}

async function getSnapshotForOwner(ownerUserId) {
  if (!ownerUserId) return null;
  const key = String(ownerUserId);
  const known = ownerToOrg.get(key);
  if (known) return getSnapshot(known);
  const doc = await Organization.findOne({ ownerUserId: key })
    .select("+whatsapp.accessTokenEncrypted +extraNumbers.accessTokenEncrypted")
    .lean();
  return doc ? remember(snapshot(doc)) : null;
}

async function getSnapshotForPhoneNumberId(phoneNumberId) {
  if (!phoneNumberId) return null;
  const known = phoneToOrg.get(String(phoneNumberId));
  if (known) {
    const snap = await getSnapshot(known);
    if (
      snap?.whatsapp?.phoneNumberId === String(phoneNumberId) ||
      (snap?.extraNumbers || []).some(
        (n) => n.phoneNumberId === String(phoneNumberId),
      )
    )
      return snap;
  }
  let doc = await Organization.findOne({
    $or: [
      { "whatsapp.phoneNumberId": String(phoneNumberId) },
      { "extraNumbers.phoneNumberId": String(phoneNumberId) },
    ],
  })
    .select("+whatsapp.accessTokenEncrypted +extraNumbers.accessTokenEncrypted")
    .lean();
  if (!doc) {
    // Migrated single-client org that still uses the env credentials.
    const env = require("../../config/env");
    if (env.platformMeta?.phoneNumberId === String(phoneNumberId)) {
      doc = await Organization.findOne({ "whatsapp.connectedVia": "env" })
        .select(
          "+whatsapp.accessTokenEncrypted +extraNumbers.accessTokenEncrypted",
        )
        .lean();
    }
  }
  return doc ? remember(snapshot(doc)) : null;
}

/** Runs fn inside the org's tenant context (or plain, if no org is found). */
async function runForOwner(ownerUserId, fn) {
  const snap = await getSnapshotForOwner(ownerUserId).catch((err) => {
    logger.warn("[saas] Could not load org for owner", {
      ownerUserId: String(ownerUserId),
      error: err.message,
    });
    return null;
  });
  if (!snap) return fn();
  return tenantContext.run(snap, fn);
}

async function runForOrg(orgId, fn) {
  const snap = await getSnapshot(orgId);
  if (!snap) return fn();
  return tenantContext.run(snap, fn);
}

/** Atomically bumps a monthly usage counter, rolling the month over if needed. */
async function incrementUsage(orgId, field, amount = 1) {
  if (!orgId) return null;
  const month = currentMonthIST();
  // Roll over first (cheap no-op when month already matches).
  await Organization.updateOne(
    { _id: orgId, "usage.month": { $ne: month } },
    {
      $set: {
        "usage.month": month,
        "usage.aiConversations": 0,
        "usage.messagesSent": 0,
        "usage.campaigns": 0,
        "usage.emailsSent": 0,
        "usage.voiceMinutes": 0,
      },
    },
  );
  const inc = { [`usage.${field}`]: amount };
  // Bulk sends also feed a lifetime counter (used for the trial's total limit).
  if (field === "messagesSent" || field === "emailsSent")
    inc.bulkMessagesTotal = amount;
  // Lifetime totals (the free trial's AI conversation / campaign limits).
  if (field === "aiConversations" || field === "campaigns")
    inc[`usageTotals.${field}`] = amount;
  await Organization.updateOne({ _id: orgId }, { $inc: inc });
  const updated = await Organization.findById(orgId)
    .select("usage bulkMessagesTotal usageTotals")
    .lean();
  const cached = byId.get(String(orgId));
  if (cached && updated) {
    cached.snap.usage = updated.usage;
    cached.snap.bulkMessagesTotal = updated.bulkMessagesTotal || 0;
    cached.snap.usageTotals = updated.usageTotals || {};
  }
  return updated?.usage || null;
}

/** Starts a new month's counters when the stored month is old (cheap no-op otherwise). */
async function rollMonth(orgId, month) {
  await Organization.updateOne(
    { _id: orgId, "usage.month": { $ne: month } },
    {
      $set: {
        "usage.month": month,
        "usage.aiConversations": 0,
        "usage.messagesSent": 0,
        "usage.campaigns": 0,
        "usage.emailsSent": 0,
        "usage.voiceMinutes": 0,
      },
    },
  );
}

/**
 * Bills AI calling minutes for a finished call.
 *  - usage.voiceMinutes (the monthly report counter) always grows by the full
 *    `billed` minutes, exactly like incrementUsage did.
 *  - The part that the monthly plan allowance cannot cover is taken from the
 *    recharged packs (org.voicePrepaidUsed, lifetime, capped at the pack
 *    balance) — so a bought pack is really consumed and never "refills" on
 *    the 1st of the month.
 * Race-safe: the monthly $inc returns the value BEFORE this call (so two calls
 * finishing together never share the same plan allowance), and the pack
 * counter is moved with a compare-and-set that re-reads on conflict.
 */
async function consumeVoiceMinutes(orgId, billed) {
  const minutes = Math.max(0, Math.floor(Number(billed) || 0));
  if (!orgId || !minutes) return null;
  const month = currentMonthIST();
  await rollMonth(orgId, month);
  const before = await Organization.findOneAndUpdate(
    { _id: orgId },
    { $inc: { "usage.voiceMinutes": minutes } },
    { new: false, projection: "usage plan limitOverrides featureOverrides addonGrants voicePrepaidUsed" },
  ).lean();
  if (!before) return null;
  const { splitVoiceMinutes } = require("./subscription"); // lazy: subscription requires this file
  const split = splitVoiceMinutes(before, minutes);
  let want = split.fromPack;
  let taken = 0;
  let current = split.packUsed;
  for (let attempt = 0; attempt < 5 && want > 0; attempt += 1) {
    const take = Math.min(want, Math.max(0, split.packPurchased - current));
    if (take <= 0) break;
    // eslint-disable-next-line no-await-in-loop
    const res = await Organization.updateOne(
      { _id: orgId, voicePrepaidUsed: current === 0 ? { $in: [0, null] } : current },
      { $inc: { voicePrepaidUsed: take } },
    );
    if (res.modifiedCount) {
      taken = take;
      break;
    }
    // Someone else consumed pack minutes at the same moment: re-read and retry.
    // eslint-disable-next-line no-await-in-loop
    const latest = await Organization.findById(orgId).select("voicePrepaidUsed").lean();
    current = Math.max(0, Number(latest?.voicePrepaidUsed) || 0);
  }
  const updated = await Organization.findById(orgId).select("usage voicePrepaidUsed").lean();
  const cached = byId.get(String(orgId));
  if (cached && updated) {
    cached.snap.usage = updated.usage;
    cached.snap.voicePrepaidUsed = updated.voicePrepaidUsed || 0;
  }
  return { billed: minutes, fromPlan: split.fromPlan, fromPack: taken, usage: updated?.usage || null };
}

/**
 * The org snapshot with the live calling counters (the 30 s cache may lag
 * behind calls that just finished, or on another server). Falls back to the
 * given snapshot if the read fails.
 */
async function withFreshVoice(org) {
  if (!org?._id) return org;
  try {
    const live = await Organization.findById(org._id)
      .select("usage voicePrepaidUsed addonGrants limitOverrides featureOverrides plan status voice.paused")
      .lean();
    // `voice` is merged (the snapshot's other voice settings stay), only `paused` is refreshed.
    return live ? { ...org, ...live, voice: { ...(org.voice || {}), ...(live.voice || {}) }, _id: org._id } : org;
  } catch {
    return org;
  }
}

function usageFor(org) {
  const month = currentMonthIST();
  const u = org?.usage || {};
  if (u.month !== month)
    return {
      month,
      aiConversations: 0,
      messagesSent: 0,
      campaigns: 0,
      emailsSent: 0,
      voiceMinutes: 0,
    };
  return {
    month,
    aiConversations: u.aiConversations || 0,
    messagesSent: u.messagesSent || 0,
    campaigns: u.campaigns || 0,
    emailsSent: u.emailsSent || 0,
    voiceMinutes: u.voiceMinutes || 0,
  };
}

module.exports = {
  currentMonthIST,
  snapshot,
  invalidate,
  getSnapshot,
  getSnapshotForOwner,
  getSnapshotForPhoneNumberId,
  runForOwner,
  runForOrg,
  incrementUsage,
  consumeVoiceMinutes,
  withFreshVoice,
  usageFor,
};
