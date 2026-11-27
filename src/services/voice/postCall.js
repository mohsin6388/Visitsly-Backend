/**
 * What happens after an AI lead call (tenant context required):
 *
 *   • scheduleRecall()   — put the lead back in the AI calling queue for a
 *                          later time (customer asked to call later, or the
 *                          call was not picked up → one retry).
 *   • sendAfterCall()    — WhatsApp message to the lead: free text inside the
 *                          24-hour window, otherwise the approved follow-up
 *                          template (Follow-ups → Setup). Never to STOP leads.
 *   • approachOnWhatsApp — the WhatsApp bot continues the call's conversation
 *                          (short message written from the call summary) so
 *                          an interested customer is moved towards a visit.
 *   • rememberCall()     — the call summary goes into the WhatsApp chat's
 *                          context so the bot never asks the same things again.
 */
const Lead = require("../../models/Lead");
const Conversation = require("../../models/Conversation");
const settingsService = require("../settings/settingsService");
const metaWhatsappClient = require("../whatsapp/metaWhatsappClient");
const { recordOutboundMessage } = require("../whatsapp/messageStore");
const policy = require("./callPolicy");
const lang = require("../language");
const logger = require("../../utils/logger");

const DAY = 24 * 3600 * 1000;

async function conversationFor(lead) {
  let conversation = await Conversation.findOne({ leadId: lead._id });
  if (conversation) return conversation;
  try {
    conversation = await Conversation.create({ leadId: lead._id, ownerId: lead.ownerId });
  } catch (err) {
    if (err.code === 11000) conversation = await Conversation.findOne({ leadId: lead._id });
    else throw err;
  }
  return conversation;
}

/** Saves the call summary on the chat (creates the chat for uploaded contacts). */
async function rememberCall(lead, summary) {
  const text = String(summary || "").trim();
  if (!lead?._id || !text) return;
  try {
    const conversation = await conversationFor(lead);
    await Conversation.updateOne({ _id: conversation._id }, { $set: { lastCallSummary: text.slice(0, 600), lastCallAt: new Date() } });
  } catch (err) {
    logger.warn("[voice] could not save call summary on the chat", { error: err.message });
  }
}

/**
 * WhatsApp to the lead after a call. { sent, via, reason }
 * via = 'text' (24h window open) | 'template' (approved follow-up template).
 */
async function sendAfterCall(lead, text) {
  if (!lead?.phone || !String(text || "").trim()) return { sent: false, reason: "No number or text" };
  if (await policy.isOptedOut(lead)) return { sent: false, reason: "Customer opted out (STOP)" };
  try {
    const conversation = await conversationFor(lead);
    const lastInbound = conversation.lastInboundAt ? new Date(conversation.lastInboundAt).getTime() : 0;
    if (Date.now() - lastInbound < DAY) {
      const { messageId } = await metaWhatsappClient.sendTextMessage({ phone: lead.phone, text });
      await recordOutboundMessage({ conversationId: conversation._id, leadId: lead._id, text, sender: "ai", whatsappMessageId: messageId, ownerId: conversation.ownerId }).catch(() => {});
      return { sent: true, via: "text" };
    }
    const settings = await settingsService.getOrCreateSettings();
    const t = settings.followUp || {};
    if (!t.templateName) {
      return { sent: false, reason: "WhatsApp not sent: the customer has not messaged in 24 hours and no follow-up template is set (Follow-ups → Setup)" };
    }
    const first = String(lead.name || "").trim().split(/\s+/)[0];
    const values = [first && !/^whatsapp$/i.test(first) ? first : "Customer", settings.companyName || "our team"];
    const count = Math.min(Math.max(Number(t.templateVariableCount) || 0, 0), values.length);
    const components = count ? [{ type: "body", parameters: values.slice(0, count).map((v) => ({ type: "text", text: String(v) })) }] : [];
    // The template's translation in the customer's saved language when the company has one (E5).
    const { messageId, languageCode } = await lang.sendTemplateInLanguage({
      phone: lead.phone,
      templateName: t.templateName,
      configuredLanguage: t.templateLanguage || "en_US",
      language: conversation.language,
      buildComponents: () => components,
    });
    await recordOutboundMessage({ conversationId: conversation._id, leadId: lead._id, text: `[Follow-up template: ${t.templateName} · ${languageCode}] ${text}`, sender: "ai", whatsappMessageId: messageId, ownerId: conversation.ownerId }).catch(() => {});
    if (!conversation.templateSent) await Conversation.updateOne({ _id: conversation._id }, { $set: { templateSent: true, templateSentAt: new Date() } }).catch(() => {});
    return { sent: true, via: "template" };
  } catch (err) {
    const reason = String(err.metaError?.message || err.message || "WhatsApp send failed");
    logger.warn("[voice] post-call WhatsApp failed", { lead: String(lead._id), error: reason });
    return { sent: false, reason };
  }
}

/**
 * Queue the lead for another AI call at `at` (moved into calling hours).
 * reason: 'callback' | 'retry'.
 */
async function scheduleRecall(lead, { at = null, delayMs = DAY, reason = "callback", settings = null, orgCountry = "IN" } = {}) {
  const s = settings || (await settingsService.getOrCreateSettings());
  const region = policy.regionForPhone(lead.phone, orgCountry);
  const target = at && at.getTime() > Date.now() ? at : new Date(Date.now() + delayMs);
  const when = policy.nextCallTime(region, s, Math.max(0, target.getTime() - Date.now()));
  const set = {
    "aiCall.status": "queued",
    "aiCall.queuedAt": new Date(),
    "aiCall.nextCallAt": when,
    "aiCall.reason": reason,
    "aiCall.error": null,
  };
  if (reason === "retry") set["aiCall.retries"] = (lead.aiCall?.retries || 0) + 1;
  else set["aiCall.retries"] = 0;
  await Lead.updateOne({ _id: lead._id, optedOut: { $ne: true } }, { $set: set });
  logger.info("[voice] AI call scheduled again", { lead: String(lead._id), reason, at: when.toISOString() });
  return when;
}

/** "tomorrow around 4:30 PM" in the customer's language. */
function whenLabel(date, language, region = "IN") {
  const tz = policy.REGION[region]?.timezone || "Asia/Kolkata";
  const ymd = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const day = ymd(date);
  const time = lang.clockTime(date, language, tz);
  if (day === ymd(new Date())) return lang.t("call.whenToday", language, { time });
  if (day === ymd(new Date(Date.now() + DAY))) return lang.t("call.whenTomorrow", language, { time });
  return lang.t("call.whenDate", language, { time, date: lang.shortDate(date, language, tz) });
}

/** Saved chat language of the lead (E5), else the company default / region. */
async function chatLanguage(lead, region = "IN") {
  const c = await Conversation.findOne({ leadId: lead._id }).select("language").lean().catch(() => null);
  if (lang.normalize(c?.language)) return lang.normalize(c.language);
  const settings = await settingsService.getOrCreateSettings().catch(() => null);
  return lang.fallbackLanguage({ settings, region });
}

/** "Theek hai, hum aapko kal 11 baje call karenge" after a call-me-later. */
async function confirmCallbackOnWhatsApp(lead, when, region = "IN") {
  const language = await chatLanguage(lead, region);
  return sendAfterCall(lead, lang.t("call.callback", language, { when: whenLabel(when, language, region) }));
}

/**
 * The WhatsApp bot picks up where the call ended (interested but no visit
 * fixed, or the call dropped). A short message written from the call summary.
 */
async function approachOnWhatsApp(lead, { summary = "", region = "IN", reason = "interested" } = {}) {
  const language = await chatLanguage(lead, region);
  const first = String(lead.name || "").trim().split(/\s+/)[0];
  let text = "";
  try {
    const apiKey = await settingsService.getGeminiKey();
    const settings = await settingsService.getOrCreateSettings();
    if (apiKey && summary) {
      const { generateContent } = require("../ai/geminiClient");
      const out = await generateContent({
        apiKey,
        systemInstruction: [
          `You write ONE short WhatsApp message (max 3 lines) from ${settings.assistant?.name || "Monica"}, a real-estate sales assistant at ${settings.companyName || "our company"}, right after a phone call with the customer.`,
          `Language: write the whole message in ${lang.scriptNote(language)}. This is the customer's saved chat language — do not use any other language.`,
          reason === "dropped" ? "The call got cut before it finished." : "The customer showed interest but no site visit was fixed yet.",
          "Refer to what was discussed (from the summary), then ask ONE question to fix a site visit day/time. Warm, no pressure, no invented facts, prices or offers. Max 1 emoji. Return only the message text.",
        ].join("\n"),
        history: [{ role: "user", text: `Customer name: ${first || "unknown"}\nCall summary: ${summary}` }],
        temperature: 0.5,
        maxModels: 2,
        groqFallback: false,
      });
      text = String(out?.text || "").replace(/^["'`]+|["'`]+$/g, "").trim().slice(0, 600);
    }
  } catch (err) {
    logger.warn("[voice] could not write the WhatsApp follow-up from the call", { error: err.message });
  }
  if (!text) text = lang.t(reason === "dropped" ? "call.dropped" : "call.interested", language, { name: lang.nameVar(lead) });
  return sendAfterCall(lead, text);
}

/** Not reached even after the retry → start the conversation on WhatsApp. */
async function notReachedOnWhatsApp(lead, region = "IN") {
  const language = await chatLanguage(lead, region);
  return sendAfterCall(lead, lang.t("call.notReached", language, { name: lang.nameVar(lead) }));
}

module.exports = { scheduleRecall, sendAfterCall, approachOnWhatsApp, confirmCallbackOnWhatsApp, notReachedOnWhatsApp, rememberCall };
