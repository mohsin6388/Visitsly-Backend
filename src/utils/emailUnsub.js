const crypto = require("crypto");
const env = require("../config/env");

/**
 * One-click unsubscribe for bulk emails (Gmail / Yahoo expect a working
 * List-Unsubscribe header + a visible link). The token is an HMAC of the lead
 * id, so nobody can unsubscribe another person's lead by guessing ids.
 */
const sign = (leadId) =>
  crypto.createHmac("sha256", `${env.encryptionKey}:email-unsub`).update(String(leadId)).digest("base64url").slice(0, 24);

function makeToken(leadId) {
  return `${leadId}.${sign(leadId)}`;
}

/** Returns the leadId for a valid token, else null. */
function verifyToken(token) {
  const [leadId, mac] = String(token || "").split(".");
  if (!/^[a-f\d]{24}$/i.test(leadId || "") || !mac) return null;
  const a = Buffer.from(mac);
  const b = Buffer.from(sign(leadId));
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? leadId : null;
}

function publicBase() {
  const base = String(process.env.PUBLIC_API_URL || "").trim().replace(/\/+$/, "").replace(/\/api$/, "");
  return /^https?:\/\//i.test(base) ? base : "";
}

/** Absolute unsubscribe URL, or "" when PUBLIC_API_URL is not set (then the footer falls back to "reply to unsubscribe"). */
function unsubscribeUrl(leadId) {
  const base = publicBase();
  return base ? `${base}/api/webhooks/email-unsubscribe/${makeToken(leadId)}` : "";
}

module.exports = { makeToken, verifyToken, unsubscribeUrl };
