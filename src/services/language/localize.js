/**
 * Writes backend messages in the customer's saved language (E5).
 *
 *   t(key, language, vars)           catalog text (messages.js), English fallback
 *   visitWhen(meeting, language)     { day, time, dateFull } in that language
 *   shortDate(date, language)        "27 Nov" / "27 नव॰" / "27 نوفمبر"
 *   fallbackLanguage({settings, region})  language for a customer who never wrote
 *   translateText(text, language)    owner-written text (custom follow-ups) → customer's language
 *   templateLanguageFor(...)         the approved translation of a WhatsApp template
 *                                    that matches the customer's language
 */
const { MESSAGES } = require("./messages");
const languages = require("./languages");
const { detectLanguage } = require("./detect");
const logger = require("../../utils/logger");

const TZ_OFFSET_MIN = 330; // visit dates / times are India time

/* ------------------------------------------------------------------ */
/* Catalog                                                             */
/* ------------------------------------------------------------------ */
function fill(text, vars = {}) {
  return String(text || "").replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? "" : String(vars[k])));
}

/** Catalog text in `language` (any spelling: "hindi", "हिंदी", "hi"…); English when unknown. */
function t(key, language, vars = {}) {
  const lang = languages.normalize(language) || "English";
  const text = MESSAGES[lang]?.[key] ?? MESSAGES.English[key];
  if (text == null) throw new Error(`Unknown message key: ${key}`);
  return fill(text, vars);
}

function has(key, language) {
  const lang = languages.normalize(language);
  return Boolean(lang && MESSAGES[lang]?.[key]);
}

/* ------------------------------------------------------------------ */
/* Small helpers for placeholders                                      */
/* ------------------------------------------------------------------ */
const PLACEHOLDER_NAMES = /^(whatsapp|lead|customer|test|unknown)$/i;

/** " Ravi" or "" — first name only, never the "WhatsApp 98…" placeholder. */
function nameVar(lead) {
  const first = String(lead?.name || "").trim().split(/\s+/)[0] || "";
  return first && !PLACEHOLDER_NAMES.test(first) && !/^\+?\d+$/.test(first) ? ` ${first}` : "";
}

function projectParen(project) {
  const p = String(project || "").trim();
  return p ? ` (${p})` : "";
}

/* ------------------------------------------------------------------ */
/* Dates & times                                                       */
/* ------------------------------------------------------------------ */
function localeOf(language) {
  return languages.info(languages.normalize(language))?.locale || "en-IN";
}

function istDay(offsetDays = 0) {
  return new Date(Date.now() + TZ_OFFSET_MIN * 60000 + offsetDays * 86400000).toISOString().slice(0, 10);
}

function safeFormat(locale, options, date) {
  try {
    return new Intl.DateTimeFormat(locale, { numberingSystem: "latn", ...options }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-IN", options).format(date);
  }
}

/** "11:00" → "11:00 AM" (in the language's own style; digits always 0-9). */
function timeLabel(hhmm, language) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || "").trim());
  if (!m) return String(hhmm || "");
  const d = new Date(Date.UTC(2000, 0, 1, Number(m[1]), Number(m[2])));
  const out = safeFormat(localeOf(language), { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "UTC" }, d);
  return out.replace(/\b(am|pm)\b/g, (x) => x.toUpperCase());
}

/** "2026-11-27" → "Fri, 27 Nov" in the language. */
function fullDate(ymd, language) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd || ""))) return String(ymd || "");
  const d = new Date(`${ymd}T00:00:00Z`);
  return safeFormat(localeOf(language), { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }, d);
}

const HINGLISH_REL = { 0: "aaj", 1: "kal", 2: "parso" };

/** "today" / "tomorrow" in the language, or null for other days. */
function relativeDay(ymd, language) {
  const lang = languages.normalize(language) || "English";
  const offset = ymd === istDay(0) ? 0 : ymd === istDay(1) ? 1 : null;
  if (offset == null) return null;
  if (lang === "Hinglish") return HINGLISH_REL[offset];
  try {
    return new Intl.RelativeTimeFormat(localeOf(lang), { numeric: "auto" }).format(offset, "day");
  } catch {
    return offset === 0 ? "today" : "tomorrow";
  }
}

/**
 * Day + time of a visit in the customer's language.
 * day = "tomorrow (Fri, 27 Nov)" when it is today/tomorrow, else "Fri, 27 Nov".
 */
function visitWhen(meeting, language) {
  const dateFull = fullDate(meeting?.preferredDate, language);
  const rel = relativeDay(meeting?.preferredDate, language);
  return {
    day: rel ? `${rel} (${dateFull})` : dateFull,
    dateFull,
    relative: rel,
    time: timeLabel(meeting?.preferredTime, language),
  };
}

/** Date → "27 Nov" in the language. Accepts a Date or "YYYY-MM-DD". */
function shortDate(date, language, timeZone = "Asia/Kolkata") {
  const d = date instanceof Date ? date : new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(date)) ? `${date}T12:00:00+05:30` : date);
  if (Number.isNaN(d.getTime())) return String(date || "");
  return safeFormat(localeOf(language), { day: "numeric", month: "short", timeZone }, d);
}

/** Time of a Date → "4:30 PM" in the language and time zone. */
function clockTime(date, language, timeZone = "Asia/Kolkata") {
  return safeFormat(localeOf(language), { hour: "numeric", minute: "2-digit", hour12: true, timeZone }, date).replace(
    /\b(am|pm)\b/g,
    (x) => x.toUpperCase(),
  );
}

/* ------------------------------------------------------------------ */
/* Which language for a customer                                       */
/* ------------------------------------------------------------------ */

/**
 * Language for a customer whose chat has no saved language yet (never wrote,
 * e.g. an uploaded contact): the company's default, else the region's.
 */
function fallbackLanguage({ settings = null, region = "IN" } = {}) {
  const def = languages.normalize(settings?.assistant?.defaultLanguage);
  if (def) return def;
  return String(region || "IN").toUpperCase() === "AE" ? "English" : "Hinglish";
}

/** Saved language of the chat (E5), else the fallback above. */
function languageFor(conversation, { settings = null, region = "IN" } = {}) {
  return languages.normalize(conversation?.language) || fallbackLanguage({ settings, region });
}

/* ------------------------------------------------------------------ */
/* Free text the company wrote (custom follow-ups, templates' text)    */
/* ------------------------------------------------------------------ */
const translationCache = new Map(); // `${language}\u0000${text}` → translated
const CACHE_MAX = 500;

/**
 * Translates company-written text into the customer's language with Gemini.
 * Returns the text unchanged when it already is in that language, when no AI
 * key is set, or when translation fails (never blocks a send).
 */
async function translateText(text, language, { apiKey = null } = {}) {
  const src = String(text || "").trim();
  const lang = languages.normalize(language);
  if (!src || !lang) return src;
  const seen = detectLanguage(src);
  if (seen.language === lang && seen.confident) return src;
  const key = `${lang}\u0000${src}`;
  if (translationCache.has(key)) return translationCache.get(key);
  try {
    const settingsService = require("../settings/settingsService");
    const k = apiKey || (await settingsService.getGeminiKey());
    if (!k) return src;
    const { generateContent } = require("../ai/geminiClient");
    const out = await generateContent({
      apiKey: k,
      systemInstruction: [
        `Translate the WhatsApp message into ${scriptNote(lang)}.`,
        "Keep names, project names, numbers, prices, dates, phone numbers, links, emojis, *bold* markers and the word STOP exactly as they are.",
        "Keep it short, warm and natural. Return ONLY the translated message.",
      ].join("\n"),
      history: [{ role: "user", text: src }],
      temperature: 0.2,
      maxModels: 2,
      groqFallback: false,
    });
    const translated = String(out?.text || "").replace(/^["'`]+|["'`]+$/g, "").trim();
    if (!translated) return src;
    if (translationCache.size >= CACHE_MAX) translationCache.delete(translationCache.keys().next().value);
    translationCache.set(key, translated);
    return translated;
  } catch (err) {
    logger.warn("[language] translation failed — sending the original text", { language: lang, error: err.message });
    return src;
  }
}

/** How a language must be written (used in AI instructions). */
function scriptNote(language) {
  return {
    English: "English",
    Hindi: "Hindi written in Devanagari script (हिंदी) — not Roman letters",
    Hinglish: "Hinglish: Hindi written in Roman (English) letters, mixed with common English words — not Devanagari",
    Urdu: "Urdu written in Urdu (Nastaliq / Arabic) script (اردو) — not Devanagari, not Roman Urdu",
    Arabic: "Arabic in Arabic script (العربية)",
    Bangla: "Bangla in Bengali script (বাংলা)",
    Marathi: "Marathi in Devanagari script (मराठी) — Marathi, not Hindi",
    Gujarati: "Gujarati in Gujarati script (ગુજરાતી)",
    Punjabi: "Punjabi in Gurmukhi script (ਪੰਜਾਬੀ)",
    Tamil: "Tamil in Tamil script (தமிழ்)",
    Telugu: "Telugu in Telugu script (తెలుగు)",
    Kannada: "Kannada in Kannada script (ಕನ್ನಡ)",
    Malayalam: "Malayalam in Malayalam script (മലയാളം)",
  }[language] || language;
}

/* ------------------------------------------------------------------ */
/* WhatsApp templates in the customer's language                       */
/* ------------------------------------------------------------------ */

/**
 * Meta lets one template name have several language translations. Returns the
 * approved translation for the customer's language when the company has one,
 * otherwise the configured language. Never throws.
 * @returns {Promise<{ languageCode: string, language: string|null, matched: boolean }>}
 */
async function templateLanguageFor({ templateName, configuredLanguage, language }) {
  const configured = String(configuredLanguage || "en_US");
  const fallback = { languageCode: configured, language: languages.fromTemplateCode(configured), matched: false };
  const wanted = languages.info(languages.normalize(language));
  if (!templateName || !wanted || !wanted.waCodes.length) return fallback;
  if (languages.fromTemplateCode(configured) === wanted.name) return { ...fallback, matched: true };
  try {
    const templates = await require("../whatsapp/openingTemplateService").getTemplates();
    const approved = templates.filter((x) => x.name === templateName && String(x.status).toUpperCase() === "APPROVED");
    for (const code of wanted.waCodes) {
      const hit = approved.find((x) => String(x.language).toLowerCase() === code.toLowerCase());
      if (hit) return { languageCode: hit.language, language: wanted.name, matched: true };
    }
    const base = approved.find((x) => languages.fromTemplateCode(x.language) === wanted.name);
    if (base) return { languageCode: base.language, language: wanted.name, matched: true };
  } catch (err) {
    logger.info("[language] template list unavailable — using the configured template language", { error: err.message });
  }
  return fallback;
}

/** Meta errors that mean "this template / translation can't be used as sent". */
const TEMPLATE_RETRY_CODES = new Set([132000, 132001, 132012]);

/**
 * Sends a template in the customer's language when an approved translation
 * exists, else in the configured language. `buildComponents(language)` makes
 * the variables in the language actually used. Retries once in the configured
 * language if Meta rejects the translation.
 * @returns {Promise<{ messageId: string|null, languageCode: string, language: string|null }>}
 */
async function sendTemplateInLanguage({ phone, templateName, configuredLanguage, language, buildComponents }) {
  const wa = require("../whatsapp/metaWhatsappClient");
  const choice = await templateLanguageFor({ templateName, configuredLanguage, language });
  const send = async (code, lang) => {
    const { messageId } = await wa.sendTemplateMessage({ phone, templateName, languageCode: code, components: buildComponents(lang) });
    return { messageId, languageCode: code, language: lang };
  };
  const configured = String(configuredLanguage || "en_US");
  try {
    return await send(choice.languageCode, choice.language);
  } catch (err) {
    const code = Number(err?.metaError?.code ?? err?.code);
    if (choice.languageCode !== configured && TEMPLATE_RETRY_CODES.has(code)) {
      logger.warn("[language] template translation rejected — sending the configured language", { templateName, tried: choice.languageCode });
      return send(configured, languages.fromTemplateCode(configured));
    }
    throw err;
  }
}

module.exports = {
  t,
  has,
  fill,
  nameVar,
  projectParen,
  timeLabel,
  fullDate,
  relativeDay,
  visitWhen,
  shortDate,
  clockTime,
  istDay,
  fallbackLanguage,
  languageFor,
  translateText,
  scriptNote,
  templateLanguageFor,
  sendTemplateInLanguage,
  localeOf,
};
