const Organization = require('../../models/Organization');
const { decrypt } = require('../../utils/crypto');
const tenantContext = require('../../context/tenantContext');
const logger = require('../../utils/logger');

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
  const o = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
  const wa = { ...(o.whatsapp || {}) };
  wa.accessToken = wa.accessTokenEncrypted ? decrypt(wa.accessTokenEncrypted) : null;
  delete wa.accessTokenEncrypted;
  const extraNumbers = (o.extraNumbers || []).map((n) => {
    const x = { ...n, _id: n._id ? String(n._id) : undefined, accessToken: n.accessTokenEncrypted ? decrypt(n.accessTokenEncrypted) : null };
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
  if (snap.whatsapp?.phoneNumberId) phoneToOrg.set(snap.whatsapp.phoneNumberId, snap._id);
  for (const n of snap.extraNumbers || []) phoneToOrg.set(n.phoneNumberId, snap._id);
  return snap;
}

function invalidate(orgId) {
  if (!orgId) return;
  const key = String(orgId);
  const cached = byId.get(key);
  if (cached?.snap?.whatsapp?.phoneNumberId) phoneToOrg.delete(cached.snap.whatsapp.phoneNumberId);
  byId.delete(key);
}

async function getSnapshot(orgId, { fresh = false } = {}) {
  if (!orgId) return null;
  const key = String(orgId);
  const cached = byId.get(key);
  if (!fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.snap;
  const doc = await Organization.findById(key).select('+whatsapp.accessTokenEncrypted +extraNumbers.accessTokenEncrypted').lean();
  if (!doc) return null;
  return remember(snapshot(doc));
}

async function getSnapshotForOwner(ownerUserId) {
  if (!ownerUserId) return null;
  const key = String(ownerUserId);
  const known = ownerToOrg.get(key);
  if (known) return getSnapshot(known);
  const doc = await Organization.findOne({ ownerUserId: key }).select('+whatsapp.accessTokenEncrypted +extraNumbers.accessTokenEncrypted').lean();
  return doc ? remember(snapshot(doc)) : null;
}

async function getSnapshotForPhoneNumberId(phoneNumberId) {
  if (!phoneNumberId) return null;
  const known = phoneToOrg.get(String(phoneNumberId));
  if (known) {
    const snap = await getSnapshot(known);
    if (snap?.whatsapp?.phoneNumberId === String(phoneNumberId) || (snap?.extraNumbers || []).some((n) => n.phoneNumberId === String(phoneNumberId))) return snap;
  }
  let doc = await Organization.findOne({ $or: [{ 'whatsapp.phoneNumberId': String(phoneNumberId) }, { 'extraNumbers.phoneNumberId': String(phoneNumberId) }] })
    .select('+whatsapp.accessTokenEncrypted +extraNumbers.accessTokenEncrypted')
    .lean();
  if (!doc) {
    // Migrated single-client org that still uses the env credentials.
    const env = require('../../config/env');
    if (env.platformMeta?.phoneNumberId === String(phoneNumberId)) {
      doc = await Organization.findOne({ 'whatsapp.connectedVia': 'env' })
        .select('+whatsapp.accessTokenEncrypted +extraNumbers.accessTokenEncrypted')
        .lean();
    }
  }
  return doc ? remember(snapshot(doc)) : null;
}

/** Runs fn inside the org's tenant context (or plain, if no org is found). */
async function runForOwner(ownerUserId, fn) {
  const snap = await getSnapshotForOwner(ownerUserId).catch((err) => {
    logger.warn('[saas] Could not load org for owner', { ownerUserId: String(ownerUserId), error: err.message });
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
    { _id: orgId, 'usage.month': { $ne: month } },
    { $set: { 'usage.month': month, 'usage.aiConversations': 0, 'usage.messagesSent': 0, 'usage.campaigns': 0, 'usage.emailsSent': 0, 'usage.voiceMinutes': 0 } }
  );
  await Organization.updateOne({ _id: orgId }, { $inc: { [`usage.${field}`]: amount } });
  const updated = await Organization.findById(orgId).select('usage').lean();
  const cached = byId.get(String(orgId));
  if (cached && updated) cached.snap.usage = updated.usage;
  return updated?.usage || null;
}

function usageFor(org) {
  const month = currentMonthIST();
  const u = org?.usage || {};
  if (u.month !== month) return { month, aiConversations: 0, messagesSent: 0, campaigns: 0, emailsSent: 0, voiceMinutes: 0 };
  return { month, aiConversations: u.aiConversations || 0, messagesSent: u.messagesSent || 0, campaigns: u.campaigns || 0, emailsSent: u.emailsSent || 0, voiceMinutes: u.voiceMinutes || 0 };
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
  usageFor,
};
