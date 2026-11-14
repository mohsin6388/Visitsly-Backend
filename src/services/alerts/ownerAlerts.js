/**
 * Instant alerts to the business owner's own WhatsApp (hot lead, visit booked,
 * visit confirmed, budget threshold …).
 *
 * Delivery ladder (first one that works wins, every step is logged):
 *   1. Free WhatsApp text from the company's number — works when the owner's
 *      number has messaged the business number in the last 24 h.
 *   2. Approved alert template (Settings → alertTemplate or
 *      META_WHATSAPP_LEAD_ALERT_TEMPLATE_NAME) — works any time.
 *   3. Email to the owner.
 * An in-app notification is always created.
 *
 * Must run inside the company's tenant context.
 */
const Organization = require("../../models/Organization");
const User = require("../../models/User");
const Notification = require("../../models/Notification");
const tenantContext = require("../../context/tenantContext");
const metaWhatsappClient = require("../whatsapp/metaWhatsappClient");
const settingsService = require("../settings/settingsService");
const logger = require("../../utils/logger");

function phonesFrom(value) {
  return String(value || "")
    .split(/[,;\n]+/)
    .map((p) => p.replace(/[^\d]/g, ""))
    .filter((p) => p.length >= 10 && p.length <= 15)
    .map((p) => (p.length === 10 ? `91${p}` : p));
}

/** Where alerts go: Settings → alert phone(s), else company phone, else owner's phone. */
async function alertTargets() {
  const org = tenantContext.getOrg();
  const settings = await settingsService.getOrCreateSettings();
  let phones = phonesFrom(settings.leadAlertPhone);
  let ownerEmail = null;
  if (org) {
    const fresh = await Organization.findById(org._id).select("phone billingEmail ownerUserId").lean();
    const owner = fresh?.ownerUserId ? await User.findById(fresh.ownerUserId).select("phone email").lean() : null;
    if (!phones.length) phones = phonesFrom(fresh?.phone || owner?.phone);
    ownerEmail = owner?.email || fresh?.billingEmail || null;
  }
  return { phones: [...new Set(phones)].slice(0, 5), email: ownerEmail, settings };
}

async function sendOne(phone, text, settings, templateValues) {
  try {
    const { messageId } = await metaWhatsappClient.sendTextMessage({ phone, text });
    return { ok: true, via: "text", messageId };
  } catch (err) {
    const windowClosed = err.code === "WHATSAPP_24H_WINDOW_CLOSED" || err.metaError?.code === 131047;
    const templateName = settings.alertTemplate?.name || process.env.META_WHATSAPP_LEAD_ALERT_TEMPLATE_NAME;
    if (!windowClosed || !templateName) return { ok: false, error: err.message, windowClosed };
    try {
      const language = settings.alertTemplate?.language || process.env.META_WHATSAPP_LEAD_ALERT_TEMPLATE_LANGUAGE || "en_US";
      const count = Math.max(0, Math.min(Number(settings.alertTemplate?.variableCount ?? 5), templateValues.length));
      const components = count
        ? [{ type: "body", parameters: templateValues.slice(0, count).map((v) => ({ type: "text", text: String(v || "-").slice(0, 1000) })) }]
        : [];
      const { messageId } = await metaWhatsappClient.sendTemplateMessage({ phone, templateName, languageCode: language, components });
      return { ok: true, via: "template", messageId };
    } catch (tplErr) {
      return { ok: false, error: tplErr.message, windowClosed: true };
    }
  }
}

/**
 * @param {object} p
 * @param {string} p.kind   hot_lead | visit_booked | visit_confirmed | visit_declined | budget | test
 * @param {string} p.title  one line, shown in WhatsApp + notification
 * @param {string[]} p.lines detail lines
 * @param {string} [p.link] dashboard deep link
 * @param {string[]} [p.templateValues] values for the approved alert template ({{1}}..{{5}})
 */
async function sendOwnerAlert({ kind, title, lines = [], link = "/dashboard", templateValues = [] }) {
  const org = tenantContext.getOrg();
  const ownerUserId = org?.ownerUserId || null;
  const text = [title, ...lines.filter(Boolean)].join("\n").slice(0, 3800);
  const result = { whatsapp: [], email: null };

  if (ownerUserId) {
    await Notification.create({ userId: ownerUserId, type: `alert_${kind}`, title: title.slice(0, 200), body: lines.filter(Boolean).join(" · ").slice(0, 500), link }).catch(() => {});
    try {
      require("../../sockets").emitToUser(ownerUserId, "notification:new", { kind });
    } catch { /* socket not ready */ }
  }

  let targets;
  try {
    targets = await alertTargets();
  } catch (err) {
    logger.warn("[alerts] could not resolve alert targets", { error: err.message });
    return result;
  }

  for (const phone of targets.phones) {
    // eslint-disable-next-line no-await-in-loop
    const r = await sendOne(phone, text, targets.settings, templateValues.length ? templateValues : [title, ...lines].slice(0, 5));
    result.whatsapp.push({ phone, ...r });
  }

  const anyWhatsapp = result.whatsapp.some((r) => r.ok);
  if (!anyWhatsapp && targets.email) {
    try {
      const { sendDirectEmail, isBrevoConfigured } = require("../email/mailer");
      if (isBrevoConfigured()) {
        const base = (process.env.CLIENT_URL || "").replace(/\/+$/, "");
        await sendDirectEmail({
          to: targets.email,
          subject: title.replace(/[\u{1F300}-\u{1FAFF}]/gu, "").trim().slice(0, 150),
          text: `${text}\n\n${base ? `Dashboard: ${base}${link}` : ""}\n\nTip: WhatsApp par alert paane ke liye apne number se business WhatsApp number par "Hi" bhej dijiye, ya Settings mein alert template chunein.`,
        });
        result.email = { ok: true, to: targets.email };
      }
    } catch (err) {
      result.email = { ok: false, error: err.message };
    }
  }

  if (!anyWhatsapp) {
    logger.info("[alerts] WhatsApp alert not delivered, used fallback", { kind, whatsapp: result.whatsapp, email: result.email });
  }
  return result;
}

module.exports = { sendOwnerAlert, alertTargets, phonesFrom };
