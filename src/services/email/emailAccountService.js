const net = require("net");
const nodemailer = require("nodemailer");
const EmailAccount = require("../../models/EmailAccount");
const { encrypt, decrypt } = require("../../utils/crypto");
const { renderTemplate, textToHtml, escapeHtml } = require("./mailer");

const ALLOWED_PORTS = new Set([25, 465, 587, 2525]);
/**
 * Provider presets. `dailyLimit` is a conservative safe default (emails / day) so a
 * campaign never burns through the provider's cap and gets the mailbox blocked.
 * 0 = no built-in cap (dedicated email-API providers / unknown hosts); the client can
 * always set their own limit on the Email setup page. Check your provider's current limits.
 * `usernameRequired`: login is NOT the email address (Brevo / SendGrid / Mailgun / SES).
 */
const PRESETS = {
  gmail: { host: "smtp.gmail.com", port: 587, secure: false, dailyLimit: 450 },
  outlook: { host: "smtp.office365.com", port: 587, secure: false, dailyLimit: 250 },
  zoho: { host: "smtp.zoho.in", port: 587, secure: false, dailyLimit: 200 },
  zoho_com: { host: "smtp.zoho.com", port: 587, secure: false, dailyLimit: 200 },
  yahoo: { host: "smtp.mail.yahoo.com", port: 587, secure: false, dailyLimit: 400 },
  hostinger: { host: "smtp.hostinger.com", port: 465, secure: true, dailyLimit: 0 },
  godaddy: { host: "smtpout.secureserver.net", port: 465, secure: true, dailyLimit: 0 },
  brevo: { host: "smtp-relay.brevo.com", port: 587, secure: false, dailyLimit: 0, usernameRequired: true },
  sendgrid: { host: "smtp.sendgrid.net", port: 587, secure: false, dailyLimit: 0, username: "apikey" },
  mailgun: { host: "smtp.mailgun.org", port: 587, secure: false, dailyLimit: 0, usernameRequired: true },
  ses: { host: "", port: 587, secure: false, dailyLimit: 0, usernameRequired: true },
};

/** Safe default daily cap for a host (used when the account has no limit of its own). */
function defaultDailyLimit(host) {
  const h = String(host || "").toLowerCase();
  const hit = Object.values(PRESETS).find((p) => p.host && p.host === h);
  return hit ? hit.dailyLimit : 0;
}
/** Effective campaign emails per day for an account (0 = unlimited). */
function dailyLimitFor(account) {
  return Number(account?.dailyLimit) > 0 ? Number(account.dailyLimit) : defaultDailyLimit(account?.host);
}

function appError(message, code, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

/** Internal network par SMTP connect karwane se bachne ke liye. */
function assertSafeHost(host) {
  const h = String(host || "").trim().toLowerCase();
  if (!h || h.length > 200 || /\s/.test(h)) throw appError("Invalid SMTP host.", "EMAIL_BAD_HOST");
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) {
    throw appError("This SMTP host is not allowed.", "EMAIL_BAD_HOST");
  }
  if (net.isIP(h)) {
    const privateV4 = /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
    if (privateV4 || h === "::1" || h.startsWith("fe80") || h.startsWith("fc") || h.startsWith("fd")) {
      throw appError("Private/internal addresses are not allowed.", "EMAIL_BAD_HOST");
    }
  }
  return h;
}

function validateInput(input = {}) {
  const preset = PRESETS[input.preset] || {};
  const fromEmail = String(input.fromEmail || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromEmail)) throw appError("Enter a valid email address.", "EMAIL_BAD_ADDRESS");
  const host = assertSafeHost(input.host || preset.host);
  const port = Number(input.port || preset.port || 587);
  if (!ALLOWED_PORTS.has(port)) throw appError("Only ports 587, 465, 25 or 2525 are allowed.", "EMAIL_BAD_PORT");
  const secure = input.secure !== undefined ? Boolean(input.secure) : port === 465;
  return {
    fromEmail,
    fromName: String(input.fromName || "").trim().slice(0, 100),
    host,
    port,
    secure,
    username: String(input.username || preset.username || fromEmail).trim(),
    dailyLimit: Math.max(0, Math.min(100000, parseInt(input.dailyLimit, 10) || 0)),
  };
}

function buildTransport(cfg, password) {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.username, pass: password },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    requireTLS: !cfg.secure && cfg.port !== 25,
  });
}

/** SMTP error ko client ke liye saaf Hinglish message me badalta hai. */
function friendlyError(err) {
  const code = String(err?.code || "");
  const msg = String(err?.response || err?.message || "");
  if (code === "EAUTH" || /535|invalid login|authentication|username and password/i.test(msg)) {
    return "Login failed. Check email/password. Gmail/Outlook need an App Password, not your normal password.";
  }
  if (["ECONNECTION", "ESOCKET", "ETIMEDOUT", "ECONNREFUSED", "EDNS", "ENOTFOUND"].includes(code)) {
    return "Could not connect to the SMTP server. Check host and port.";
  }
  if (/rate|limit|too many|quota|throttl/i.test(msg) && /^4|^5\.?4|4\.\d\.\d|5\.4\.5|exceed/i.test(msg)) {
    return "Your provider’s sending limit was reached. Try later or lower the daily limit.";
  }
  if (/self.signed|certificate|ssl|tls/i.test(msg)) return "Secure (SSL/TLS) connection failed. Check port and SSL settings.";
  return msg.slice(0, 200) || "Could not verify the email account.";
}

/** Campaign emails sent today (India time) — shown on the Email setup page. */
async function sentToday(ownerId) {
  const EmailMessage = require("../../models/EmailMessage");
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  ist.setUTCHours(0, 0, 0, 0);
  return EmailMessage.countDocuments({
    ownerId, direction: "outbound", kind: "campaign",
    status: { $in: ["sending", "sent", "delivered", "delivery_delayed", "bounced", "complained"] },
    sentAt: { $gte: new Date(ist.getTime() - 5.5 * 3600 * 1000) },
  });
}

async function getAccount(ownerId, { withPassword = false } = {}) {
  const q = EmailAccount.findOne({ ownerId });
  if (withPassword) q.select("+passwordEncrypted");
  return q;
}

function publicView(account) {
  if (!account) return { connected: false };
  return {
    connected: account.status === "connected",
    status: account.status,
    fromEmail: account.fromEmail,
    fromName: account.fromName,
    host: account.host,
    port: account.port,
    secure: account.secure,
    username: account.username,
    dailyLimit: account.dailyLimit || 0,
    effectiveDailyLimit: dailyLimitFor(account),
    lastError: account.lastError,
    verifiedAt: account.verifiedAt,
  };
}

/** Save karne se pehle SMTP login verify karta hai. Galat ho to save nahi hota. */
async function saveAccount(ownerId, input) {
  const cfg = validateInput(input);
  const existing = await getAccount(ownerId, { withPassword: true });
  const password = String(input.password || "").trim() || (existing ? decrypt(existing.passwordEncrypted) : "");
  if (!password) throw appError("Enter your password / App Password.", "EMAIL_NO_PASSWORD");

  try {
    await buildTransport(cfg, password).verify();
  } catch (err) {
    throw appError(friendlyError(err), "EMAIL_VERIFY_FAILED");
  }

  const doc = await EmailAccount.findOneAndUpdate(
    { ownerId },
    {
      $set: { ...cfg, passwordEncrypted: encrypt(password), status: "connected", lastError: null, verifiedAt: new Date() },
      $setOnInsert: { ownerId },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return publicView(doc);
}

async function removeAccount(ownerId) {
  await EmailAccount.deleteOne({ ownerId });
}

async function markError(ownerId, message) {
  await EmailAccount.updateOne({ ownerId }, { $set: { status: "error", lastError: String(message).slice(0, 300) } }).catch(() => {});
}

function fromHeader(account) {
  return account.fromName ? `"${account.fromName.replace(/"/g, "")}" <${account.fromEmail}>` : account.fromEmail;
}

/** Client ke apne SMTP se ek email bhejta hai. */
async function sendMail(account, { to, subject, text, html, headers }) {
  const password = decrypt(account.passwordEncrypted);
  if (!password) throw appError("Could not read the email account password. Reconnect the account.", "EAUTH");
  const transport = buildTransport(account, password);
  try {
    const info = await transport.sendMail({
      from: fromHeader(account),
      replyTo: account.fromEmail,
      to,
      subject,
      text,
      html,
      headers,
    });
    return { messageId: info.messageId, accepted: info.accepted || [], rejected: info.rejected || [] };
  } finally {
    transport.close();
  }
}

/** Campaign email: template variables fill karke, company footer + one-click unsubscribe ke saath. */
async function sendCampaignEmail(account, { to, subject, body, imageUrl = "", vars = {}, companyName = "", unsubscribeUrl = "" }) {
  const finalSubject = renderTemplate(subject, vars);
  const finalBody = renderTemplate(body, vars);
  const footer = companyName ? `${companyName}\n` : "";
  const unsubscribeNote = unsubscribeUrl
    ? "Don’t want these emails? Unsubscribe using the link below."
    : "If you don’t want these emails, reply to this email and we’ll remove you.";
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#1e293b">
      ${imageUrl && /^https:\/\//i.test(imageUrl) ? `<img src="${escapeHtml(imageUrl)}" alt="" style="display:block;max-width:100%;height:auto;border-radius:10px;margin:0 0 20px;" />` : ""}
      ${textToHtml(finalBody)}
      <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0">
      <p style="font-size:12px;color:#64748b;line-height:1.5">${escapeHtml(footer)}${escapeHtml(unsubscribeNote)}${unsubscribeUrl ? ` <a href="${escapeHtml(unsubscribeUrl)}" style="color:#64748b">Unsubscribe</a>` : ""}</p>
    </div>`;
  const headers = {
    Precedence: "bulk",
    ...(unsubscribeUrl
      ? { "List-Unsubscribe": `<${unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }
      : {}),
  };
  const result = await sendMail(account, {
    to,
    subject: finalSubject,
    text: `${finalBody}\n\n--\n${footer}${unsubscribeNote}${unsubscribeUrl ? `\n${unsubscribeUrl}` : ""}`,
    html,
    headers,
  });
  if (result.rejected.length && !result.accepted.length) {
    throw appError("Server ne is email address ko reject kar diya.", "EENVELOPE", { responseCode: 550 });
  }
  return result;
}

module.exports = {
  PRESETS,
  defaultDailyLimit,
  sentToday,
  dailyLimitFor,
  getAccount,
  publicView,
  saveAccount,
  removeAccount,
  markError,
  sendMail,
  sendCampaignEmail,
  friendlyError,
  fromHeader,
};
