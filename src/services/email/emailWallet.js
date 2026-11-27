const Organization = require("../../models/Organization");
const EmailWalletTx = require("../../models/EmailWalletTx");
const OutboundJob = require("../../models/OutboundJob");
const logger = require("../../utils/logger");

/**
 * Per-email wallet for campaign e-mail (mirrors the AI-calling minutes wallet).
 *
 *  - Money is stored as INTEGER milli-rupees (1 INR = 1000), never floats.
 *  - One e-mail costs (EMAIL_COST_PER_EMAIL + EMAIL_MARGIN_PER_EMAIL), default 0.20 + 0.10 = ₹0.30,
 *    plus 18 % GST on the recharge invoice (₹0.354 all-in). GST is tax, not wallet value:
 *    a recharge of N emails credits N × ₹0.30 to the wallet.
 *  - Clients only ever see the all-in price; cost and margin are for the admin panel.
 *  - Every movement has a unique ledger `key`, so a retry / webhook replay / worker restart
 *    can never charge or credit twice. The balance can never go below zero.
 */
const toMilli = (rupees) => Math.max(0, Math.round(Number(rupees) * 1000) || 0);
const num = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
};

function pricing() {
  const costMilli = toMilli(num("EMAIL_COST_PER_EMAIL", 0.2));
  const marginMilli = toMilli(num("EMAIL_MARGIN_PER_EMAIL", 0.1));
  return { costMilli, marginMilli, unitMilli: Math.max(1, costMilli + marginMilli) };
}

/** What the client sees: price per e-mail before and after GST. No cost / margin. */
function clientPrice() {
  const { unitMilli } = pricing();
  const gstRate = require("../../config/pricing").taxRate("INR");
  return { currency: "INR", perEmail: unitMilli / 1000, gstRate, perEmailWithGst: Math.round(unitMilli * (1 + gstRate)) / 1000 };
}

/** Recharge quote for `emails` e-mails: amount before tax in rupees (2 decimals). */
function quote(emails) {
  const n = Math.max(0, Math.floor(Number(emails) || 0));
  const { unitMilli } = pricing();
  return { emails: n, unitMilli, amountMilli: n * unitMilli, amount: (n * unitMilli) / 1000 };
}

const walletOf = (org) => ({
  balanceMilli: Math.max(0, Number(org?.emailWallet?.balanceMilli) || 0),
  rechargedMilli: Number(org?.emailWallet?.rechargedMilli) || 0,
  spentMilli: Number(org?.emailWallet?.spentMilli) || 0,
});

/** Client-safe summary. */
function summary(org) {
  const w = walletOf(org);
  const { unitMilli } = pricing();
  return {
    balance: w.balanceMilli / 1000,
    emailsLeft: Math.floor(w.balanceMilli / unitMilli),
    price: clientPrice(),
  };
}

/** Launch-time check: can the wallet pay for `count` e-mails? */
function estimate(org, count) {
  const w = walletOf(org);
  const { unitMilli } = pricing();
  const emails = Math.max(0, Math.floor(Number(count) || 0));
  const needMilli = emails * unitMilli;
  return {
    emails,
    cost: needMilli / 1000,
    costWithGst: Math.round(needMilli * (1 + clientPrice().gstRate)) / 1000,
    balance: w.balanceMilli / 1000,
    emailsLeft: Math.floor(w.balanceMilli / unitMilli),
    enough: w.balanceMilli >= needMilli,
    shortfallEmails: Math.max(0, emails - Math.floor(w.balanceMilli / unitMilli)),
  };
}

const isDup = (err) => err && (err.code === 11000 || /E11000/.test(String(err.message)));

/**
 * Idempotent ledger insert. Returns the EXISTING row when `key` was used before, or null when
 * this call created it (so exactly one caller "owns" the movement).
 */
async function claimTx(row) {
  try {
    return await EmailWalletTx.findOneAndUpdate({ key: row.key }, { $setOnInsert: row }, { upsert: true, new: false });
  } catch (err) {
    if (isDup(err)) return EmailWalletTx.findOne({ key: row.key }).lean();
    throw err;
  }
}

/** Atomic "subtract unless it would go below zero". */
async function takeFromBalance(orgId, amountMilli) {
  return Organization.findOneAndUpdate(
    { _id: orgId, "emailWallet.balanceMilli": { $gte: amountMilli } },
    { $inc: { "emailWallet.balanceMilli": -amountMilli, "emailWallet.spentMilli": amountMilli } },
    { new: true },
  );
}
const giveToBalance = (orgId, amountMilli, field) =>
  Organization.findOneAndUpdate({ _id: orgId }, { $inc: { "emailWallet.balanceMilli": amountMilli, ...(field ? { [`emailWallet.${field}`]: amountMilli } : {}) } }, { new: true });

/**
 * Charges one e-mail to the wallet for this job. Safe to call again for the same job:
 *   { ok:true, charged:true }   money was taken now
 *   { ok:true, charged:false }  this job was already paid for
 *   { ok:false, reason:"insufficient" }  wallet is empty (nothing was taken)
 */
async function debitForJob(orgId, jobId) {
  const { costMilli, marginMilli, unitMilli } = pricing();
  const key = `debit:job:${jobId}`;
  const row = { orgId, key, type: "debit", amountMilli: unitMilli, emails: 1, costMilli, marginMilli, refundedAt: null, jobId };
  const existing = await claimTx(row);
  if (existing) {
    if (!existing.refundedAt) return { ok: true, charged: false };
    // Earlier attempt was refunded (our-side failure): charge again for the retry, exactly once.
    const reopened = await EmailWalletTx.findOneAndUpdate({ key, refundedAt: { $ne: null } }, { $set: { refundedAt: null } }, { new: true });
    if (!reopened) return { ok: true, charged: false };
    const taken = await takeFromBalance(orgId, unitMilli);
    if (!taken) {
      await EmailWalletTx.updateOne({ key }, { $set: { refundedAt: new Date() } });
      return { ok: false, reason: "insufficient" };
    }
    return { ok: true, charged: true };
  }
  const taken = await takeFromBalance(orgId, unitMilli);
  if (!taken) {
    await EmailWalletTx.deleteOne({ key }).catch(() => {});
    return { ok: false, reason: "insufficient" };
  }
  return { ok: true, charged: true, balanceMilli: taken.emailWallet?.balanceMilli };
}

/** Gives the money back for a job that failed on OUR side. Idempotent. */
async function refundJob(orgId, jobId) {
  const key = `debit:job:${jobId}`;
  const claimed = await EmailWalletTx.findOneAndUpdate({ key, type: "debit", refundedAt: null }, { $set: { refundedAt: new Date() } }, { new: false });
  if (!claimed) return false; // never charged, or already refunded
  await Organization.findOneAndUpdate({ _id: orgId }, { $inc: { "emailWallet.balanceMilli": claimed.amountMilli, "emailWallet.spentMilli": -claimed.amountMilli } });
  return true;
}

/** Recharge paid (Razorpay invoice) → credit N emails. Idempotent per invoice. */
async function creditRecharge(orgId, invoiceId, emails) {
  const { costMilli, marginMilli, unitMilli } = pricing();
  const n = Math.max(0, Math.floor(Number(emails) || 0));
  if (!n) return false;
  const row = { orgId, key: `recharge:inv:${invoiceId}`, type: "recharge", amountMilli: n * unitMilli, emails: n, costMilli: n * costMilli, marginMilli: n * marginMilli, refundedAt: null, invoiceId };
  if (await claimTx(row)) return false;
  await giveToBalance(orgId, n * unitMilli, "rechargedMilli");
  await resumePausedJobs(orgId);
  return true;
}

/** Platform admin manual credit (or negative adjustment). Always audited by the caller. */
async function adminAdjust(orgId, { emails, actorId, note = "" }) {
  const n = Math.trunc(Number(emails) || 0);
  if (!n) return { changed: false };
  const { costMilli, marginMilli, unitMilli } = pricing();
  const amountMilli = Math.abs(n) * unitMilli;
  const key = `admin:${orgId}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
  if (n > 0) {
    await claimTx({ orgId, key, type: "admin_credit", amountMilli, emails: n, costMilli: Math.abs(n) * costMilli, marginMilli: Math.abs(n) * marginMilli, refundedAt: null, actorId, note: String(note).slice(0, 200) });
    await giveToBalance(orgId, amountMilli);
    await resumePausedJobs(orgId);
  } else {
    const taken = await Organization.findOneAndUpdate({ _id: orgId, "emailWallet.balanceMilli": { $gte: amountMilli } }, { $inc: { "emailWallet.balanceMilli": -amountMilli } }, { new: true });
    if (!taken) return { changed: false, reason: "insufficient" };
    await claimTx({ orgId, key, type: "admin_debit", amountMilli, emails: Math.abs(n), refundedAt: null, actorId, note: String(note).slice(0, 200) });
  }
  return { changed: true };
}

const WALLET_PAUSE_REASON = "Email wallet is empty — recharge to resume";

/** Jobs paused because the wallet was empty go back to pending (called after any credit). */
async function resumePausedJobs(orgId) {
  try {
    const org = await Organization.findById(orgId).select("ownerUserId").lean();
    if (!org?.ownerUserId) return 0;
    const r = await OutboundJob.updateMany(
      { ownerId: org.ownerUserId, channel: "email", status: "paused", lastError: WALLET_PAUSE_REASON },
      { $set: { status: "pending", lastError: null, nextRunAt: new Date() } },
    );
    return r?.modifiedCount || 0;
  } catch (err) {
    logger.warn("[email-wallet] resume failed", { error: err.message });
    return 0;
  }
}

async function recentLedger(orgId, limit = 30) {
  return EmailWalletTx.find({ orgId, type: { $ne: "debit" } }).sort({ createdAt: -1 }).limit(limit).lean();
}

module.exports = {
  WALLET_PAUSE_REASON, pricing, clientPrice, quote, summary, estimate, debitForJob, refundJob,
  creditRecharge, adminAdjust, resumePausedJobs, recentLedger, walletOf,
};
