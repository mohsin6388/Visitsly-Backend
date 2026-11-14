const net = require("net");
const nodemailer = require("nodemailer");
const EmailAccount = require("../../models/EmailAccount");
const { encrypt, decrypt } = require("../../utils/crypto");
const { renderTemplate, textToHtml, escapeHtml } = require("./mailer");

const ALLOWED_PORTS = new Set([25, 465, 587, 2525]);
const PRESETS = {
  gmail: { host: "smtp.gmail.com", port: 587, secure: false },
  outlook: { host: "smtp.office365.com", port: 587, secure: false },
  zoho: { host: "smtp.zoho.in", port: 587, secure: false },
};

function appError(message, code, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

/** Internal network par SMTP connect karwane se bachne ke liye. */
function assertSafeHost(host) {
  const h = String(host || "").trim().toLowerCase();
  if (!h || h.length > 200 || /\s/.test(h)) throw appError("SMTP host sahi nahi hai.", "EMAIL_BAD_HOST");
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) {
    throw appError("Ye SMTP host allowed nahi hai.", "EMAIL_BAD_HOST");
  }
  if (net.isIP(h)) {
    const privateV4 = /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
    if (privateV4 || h === "::1" || h.startsWith("fe80") || h.startsWith("fc") || h.startsWith("fd")) {
      throw appError("Private/internal address allowed nahi hai.", "EMAIL_BAD_HOST");
    }
  }
  return h;
}

function validateInput(input = {}) {
  const preset = PRESETS[input.preset] || {};
  const fromEmail = String(input.fromEmail || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromEmail)) throw appError("Sahi email address daaliye.", "EMAIL_BAD_ADDRESS");
  const host = assertSafeHost(input.host || preset.host);
  const port = Number(input.port || preset.port || 587);
  if (!ALLOWED_PORTS.has(port)) throw appError("Port 587, 465, 25 ya 2525 hi allowed hai.", "EMAIL_BAD_PORT");
  const secure = input.secure !== undefined ? Boolean(input.secure) : port === 465;
  return {
    fromEmail,
    fromName: String(input.fromName || "").trim().slice(0, 100),
    host,
    port,
    secure,
    username: String(input.username || fromEmail).trim(),
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
    return "Login fail hua. Email/password check karein. Gmail/Outlook me normal password nahi, App Password use hota hai.";
  }
  if (["ECONNECTION", "ESOCKET", "ETIMEDOUT", "ECONNREFUSED", "EDNS", "ENOTFOUND"].includes(code)) {
    return "SMTP server se connect nahi ho paaya. Host aur port check karein.";
  }
  if (/self.signed|certificate|ssl|tls/i.test(msg)) return "Secure (SSL/TLS) connection fail hua. Port aur SSL setting check karein.";
  return msg.slice(0, 200) || "Email account verify nahi ho paaya.";
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
    lastError: account.lastError,
    verifiedAt: account.verifiedAt,
  };
}

/** Save karne se pehle SMTP login verify karta hai. Galat ho to save nahi hota. */
async function saveAccount(ownerId, input) {
  const cfg = validateInput(input);
  const existing = await getAccount(ownerId, { withPassword: true });
  const password = String(input.password || "").trim() || (existing ? decrypt(existing.passwordEncrypted) : "");
  if (!password) throw appError("Password / App Password daaliye.", "EMAIL_NO_PASSWORD");

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
  if (!password) throw appError("Email account ka password padha nahi ja saka. Account dobara connect karein.", "EAUTH");
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

/** Campaign email: template variables fill karke, company footer ke saath. */
async function sendCampaignEmail(account, { to, subject, body, imageUrl = "", vars = {}, companyName = "" }) {
  const finalSubject = renderTemplate(subject, vars);
  const finalBody = renderTemplate(body, vars);
  const footer = companyName ? `${companyName}\n` : "";
  const unsubscribeNote = "Agar aap ye emails nahi chahte to is email ka reply karke bata dein, hum aapko list se hata denge.";
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#1e293b">
      ${imageUrl && /^https:\/\//i.test(imageUrl) ? `<img src="${escapeHtml(imageUrl)}" alt="" style="display:block;max-width:100%;height:auto;border-radius:10px;margin:0 0 20px;" />` : ""}
      ${textToHtml(finalBody)}
      <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0">
      <p style="font-size:12px;color:#64748b;line-height:1.5">${escapeHtml(footer)}${escapeHtml(unsubscribeNote)}</p>
    </div>`;
  const result = await sendMail(account, {
    to,
    subject: finalSubject,
    text: `${finalBody}\n\n--\n${footer}${unsubscribeNote}`,
    html,
  });
  if (result.rejected.length && !result.accepted.length) {
    throw appError("Server ne is email address ko reject kar diya.", "EENVELOPE", { responseCode: 550 });
  }
  return result;
}

module.exports = {
  PRESETS,
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
