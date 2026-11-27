/**
 * Platform-managed AI voice calling — Plivo (telephony) + ElevenLabs (voice)
 * + Gemini (brain, Groq fallback).
 *
 * Clients never set anything up. Visitsly owns the Plivo number and the
 * ElevenLabs voice; the language is picked from the customer's chat language
 * (or the company's country).
 *
 * .env
 *   PLIVO_AUTH_ID=MAxxxxxxxxxxxxxxxxxx
 *   PLIVO_AUTH_TOKEN=xxxxxxxx
 *   PLIVO_FROM_NUMBER=+91XXXXXXXXXX            (your Plivo number, caller ID)
 *   PLIVO_FROM_NUMBERS_JSON={"IN":"+91...","AE":"+971..."}   (optional, per country)
 *   ELEVENLABS_API_KEY=sk_...
 *   ELEVENLABS_VOICE_ID=xxxxxxxxxxxxxxxx        (your voice)
 *   ELEVENLABS_VOICES_JSON={"hi":"voiceA","en":"voiceB"}     (optional, per language)
 *   ELEVENLABS_MODEL_ID=eleven_flash_v2_5       (optional; eleven_multilingual_v2 = richer but slower)
 *   VOICE_AGENT_NAME=Priya                      (name the agent uses on the call)
 *   VOICE_AGENT_GENDER=female                   (female | male — Hindi verbs follow it: "bol rahi / bol raha")
 *   VOICE_WEBHOOK_SECRET=long-random-string     (protects the Plivo callbacks)
 *   PUBLIC_API_URL=https://api.yourdomain.com   (Plivo must reach this over HTTPS)
 */
const LANG_LABEL = { hi: "Hindi / Hinglish", en: "English", ar: "Arabic", ur: "Urdu", mr: "Marathi", gu: "Gujarati", bn: "Bengali", pa: "Punjabi", ta: "Tamil", te: "Telugu", kn: "Kannada", ml: "Malayalam" };

// Speech-recognition language used by Plivo for each voice language.
const STT_LANG = { hi: "hi-IN", en: "en-IN", ar: "ar-AE", ur: "ur-IN", mr: "mr-IN", gu: "gu-IN", bn: "bn-IN", pa: "pa-IN", ta: "ta-IN", te: "te-IN", kn: "kn-IN", ml: "ml-IN" };
// Voice code → chat language (services/language) for the opening lines.
const CODE_LANGUAGE = { en: "English", hi: "Hindi", ar: "Arabic", ur: "Urdu", bn: "Bangla", mr: "Marathi", gu: "Gujarati", pa: "Punjabi", ta: "Tamil", te: "Telugu", kn: "Kannada", ml: "Malayalam" };
// Languages the call agent speaks (VOICE_LANGUAGES, default hi,en,ar). Anything else falls back to the country default.
const supportedCodes = () => require("../services/voice/callPolicy").voiceLanguages();

// Default language per country when the customer has not picked one.
const COUNTRY_LANG = {
  IN: "hi", NP: "hi", BD: "en", LK: "en",
  AE: "en", SA: "ar", QA: "ar", OM: "ar", KW: "ar", BH: "ar",
  GB: "en", US: "en", CA: "en", AU: "en", SG: "en", NZ: "en", IE: "en",
};

function parseJson(name) {
  try {
    const raw = process.env[name];
    const v = raw ? JSON.parse(raw) : {};
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

const env = (k) => String(process.env[k] || "").trim();

function plivo() {
  const authId = env("PLIVO_AUTH_ID");
  const authToken = env("PLIVO_AUTH_TOKEN");
  return authId && authToken ? { authId, authToken } : null;
}

function publicBase() {
  return env("PUBLIC_API_URL").replace(/\/+$/, "").replace(/\/api$/, "") || null;
}

function webhookSecret() {
  return env("VOICE_WEBHOOK_SECRET") || null;
}

function agentName() {
  return env("VOICE_AGENT_NAME") || "Priya";
}

function agentGender() {
  return /^m/i.test(env("VOICE_AGENT_GENDER")) ? "male" : "female";
}

function fromNumberFor(country) {
  const map = parseJson("PLIVO_FROM_NUMBERS_JSON");
  return map[String(country || "").toUpperCase()] || map.default || env("PLIVO_FROM_NUMBER") || null;
}

function voiceIdFor(language) {
  const map = parseJson("ELEVENLABS_VOICES_JSON");
  return map[language] || map.default || env("ELEVENLABS_VOICE_ID") || null;
}

function elevenLabs(language) {
  const apiKey = env("ELEVENLABS_API_KEY");
  const voiceId = voiceIdFor(language);
  if (!apiKey || !voiceId) return null;
  return { apiKey, voiceId, modelId: env("ELEVENLABS_MODEL_ID") || "eleven_flash_v2_5" };
}

/** Customer's language text ("Hindi", "hinglish", "English", "ar") → 2-letter code. */
function normalizeLanguage(value) {
  const v = String(value || "").trim().toLowerCase();
  if (!v) return null;
  if (/hindi|hinglish|^hi\b/.test(v)) return "hi";
  if (/english|^en\b/.test(v)) return "en";
  if (/arabic|^ar\b/.test(v)) return "ar";
  if (/urdu|^ur\b/.test(v)) return "ur";
  if (/marathi|^mr\b/.test(v)) return "mr";
  if (/gujarati|^gu\b/.test(v)) return "gu";
  if (/bengali|bangla|^bn\b/.test(v)) return "bn";
  if (/punjabi|^pa\b/.test(v)) return "pa";
  if (/tamil|^ta\b/.test(v)) return "ta";
  if (/telugu|^te\b/.test(v)) return "te";
  if (/kannada|^kn\b/.test(v)) return "kn";
  if (/malayalam|^ml\b/.test(v)) return "ml";
  return v.slice(0, 2);
}

/** What is missing for calls to work (empty array = ready). */
function missing() {
  const out = [];
  if (!plivo()) out.push("PLIVO_AUTH_ID / PLIVO_AUTH_TOKEN");
  if (!env("PLIVO_FROM_NUMBER") && !Object.keys(parseJson("PLIVO_FROM_NUMBERS_JSON")).length) out.push("PLIVO_FROM_NUMBER");
  if (!publicBase()) out.push("PUBLIC_API_URL");
  return out;
}

/** True when the platform can place calls at all. */
function isConfigured() {
  return missing().length === 0;
}

/**
 * Picks caller number, voice and language for a company (country) and the
 * customer's language. Null when calling is not set up.
 */
function resolve({ country = "IN", language = null } = {}) {
  if (!isConfigured()) return null;
  const C = String(country || "IN").toUpperCase();
  const wanted = normalizeLanguage(language);
  const SUPPORTED = supportedCodes();
  const lang = SUPPORTED.includes(wanted) ? wanted : SUPPORTED.includes(COUNTRY_LANG[C]) ? COUNTRY_LANG[C] : "en";
  const fromNumber = fromNumberFor(C);
  if (!fromNumber) return null;
  return {
    provider: "plivo",
    fromNumber,
    language: lang,
    languageLabel: LANG_LABEL[lang] || lang,
    sttLanguage: STT_LANG[lang] || "en-IN",
    tts: elevenLabs(lang), // null → Plivo's own voice is used as a fallback
  };
}

/* ---------------- Spoken date / time labels ---------------- */

const HI_MONTHS = ["जनवरी", "फ़रवरी", "मार्च", "अप्रैल", "मई", "जून", "जुलाई", "अगस्त", "सितंबर", "अक्टूबर", "नवंबर", "दिसंबर"];
const HI_DAYS = ["रविवार", "सोमवार", "मंगलवार", "बुधवार", "गुरुवार", "शुक्रवार", "शनिवार"];
const EN_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const EN_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function istDay(offsetDays = 0) {
  return new Date(Date.now() + 330 * 60000 + offsetDays * 86400000).toISOString().slice(0, 10);
}

/** "2026-11-18" → "कल" / "tomorrow" / "21 नवंबर, शनिवार". */
function spokenDate(date, language = "hi") {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) return "";
  const d = new Date(`${date}T00:00:00Z`);
  const en = language === "en" || language === "ar";
  if (date === istDay(0)) return en ? "today" : "आज";
  if (date === istDay(1)) return en ? "tomorrow" : "कल";
  if (date === istDay(2) && !en) return "परसों";
  return en
    ? `${EN_DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${EN_MONTHS[d.getUTCMonth()]}`
    : `${d.getUTCDate()} ${HI_MONTHS[d.getUTCMonth()]}, ${HI_DAYS[d.getUTCDay()]}`;
}

/** "16:30" → "शाम 4:30 बजे" / "4:30 PM". */
function spokenTime(time, language = "hi") {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time || ""));
  if (!m) return "";
  const h = Number(m[1]);
  const min = Number(m[2]);
  const h12 = h % 12 || 12;
  const clock = min ? `${h12}:${String(min).padStart(2, "0")}` : `${h12}`;
  if (language === "en" || language === "ar") return `${clock} ${h >= 12 ? "PM" : "AM"}`;
  const part = h < 12 ? "सुबह" : h < 16 ? "दोपहर" : h < 20 ? "शाम" : "रात";
  return `${part} ${clock} बजे`;
}

/* ---------------- Opening lines ---------------- */

/** Opening line from the language catalog (Arabic, Urdu, Tamil … — services/language/messages.js). */
function catalogLine(language, key, { name, project, date, time, company }) {
  const L = CODE_LANGUAGE[language] || "English";
  const lang = require("../services/language");
  const who = firstName(name);
  const when = lang.visitWhen({ preferredDate: date, preferredTime: time }, L);
  const vars = {
    name: who ? ` ${who}` : "",
    agent: agentName(),
    company: company || "—",
    project: project || "—",
    projectParen: lang.projectParen(project),
    day: when.relative || when.dateFull,
    time: when.time,
  };
  return `${lang.t("voice.hello", L, vars)} ${lang.t(key, L, vars)}`;
}

function firstName(name) {
  const f = String(name || "").trim().split(/\s+/)[0] || "";
  return /^(whatsapp|lead|customer|test)$/i.test(f) ? "" : f;
}

/**
 * First thing the agent says on a visit-confirmation call.
 * tentative = the customer said "yes" to a visit but no date was fixed yet.
 */
function confirmationScript(language, { name, project, date, time, company, tentative = false }) {
  const who = firstName(name);
  const agent = agentName();
  const female = agentGender() === "female";
  const co = company || (language === "hi" ? "हमारी टीम" : "our team");
  if (language !== "en" && language !== "hi") {
    return catalogLine(language, tentative ? "voice.confirmTentative" : "voice.confirm", { name, project, date, time, company });
  }
  if (language === "en") {
    const hello = `Hello${who ? ` ${who}` : ""}, this is ${agent} calling from ${co}.`;
    if (tentative) return `${hello} You showed interest in a site visit${project ? ` to ${project}` : ""}. Which day and time would suit you to visit?`;
    return `${hello} You booked a site visit${project ? ` to ${project}` : ""} with us on WhatsApp, for ${spokenDate(date, "en")} at ${spokenTime(time, "en")}. I'm calling to confirm — will you be able to come? Please say yes or no.`;
  }
  const hello = `नमस्ते${who ? ` ${who} जी` : ""}, मैं ${co} से ${agent} ${female ? "बोल रही" : "बोल रहा"} हूँ।`;
  if (tentative) return `${hello} आपने${project ? ` ${project} की` : ""} site visit के लिए हाँ कहा था। आप किस दिन और कितने बजे आना चाहेंगे?`;
  return `${hello} आपने WhatsApp पर${project ? ` ${project} की` : ""} site visit ${spokenDate(date, "hi")} ${spokenTime(time, "hi")} के लिए बुक की है। Confirm करने के लिए call किया है — क्या आप आ पाएँगे? हाँ या ना में बता दीजिए।`;
}

/** Visit-day reminder call: the visit is today and already confirmed. */
function reminderScript(language, { name, project, time, company }) {
  const who = firstName(name);
  const agent = agentName();
  const female = agentGender() === "female";
  if (language !== "en" && language !== "hi") return catalogLine(language, "voice.reminder", { name, project, time, company });
  if (language === "en") {
    return `Hello${who ? ` ${who}` : ""}, this is ${agent} from ${company || "our team"}. Just a reminder: your site visit${project ? ` to ${project}` : ""} is today at ${spokenTime(time, "en")}, and it is confirmed. We hope to see you there — will you be coming?`;
  }
  return `नमस्ते${who ? ` ${who} जी` : ""}, मैं ${company || "हमारी टीम"} से ${agent} ${female ? "बोल रही" : "बोल रहा"} हूँ। बस याद दिलाने के लिए call किया है — आपकी${project ? ` ${project} की` : ""} site visit आज ${spokenTime(time, "hi")} confirm है। उम्मीद है आप पहुँच जाएँगे — आप आ रहे हैं ना?`;
}

/**
 * Opening for a general (non-visit) call: new enquiry follow-up.
 * askLanguage = no chat language is saved yet → the default Hindi opening asks
 * "Hindi or English?". A saved language is never asked again (E5).
 */
function enquiryScript(language, { name, project, company, cold = false, hasScript = false, askLanguage = true }) {
  const who = firstName(name);
  const agent = agentName();
  const female = agentGender() === "female";
  if (language !== "en" && language !== "hi") {
    return catalogLine(language, cold || !project ? "voice.enquiryCold" : "voice.enquiry", { name, project, company });
  }
  if (language === "en") {
    const why = cold ? "I'm calling to tell you about some properties we have" : `You had enquired about ${project || "a property"}`;
    return `Hello${who ? ` ${who}` : ""}, this is ${agent} from ${company || "our team"}. ${why} — is this a good time to talk for a minute?`;
  }
  const hello = `नमस्ते${who ? ` ${who} जी` : ""}, मैं ${company || "हमारी टीम"} से ${agent} ${female ? "बोल रही" : "बोल रहा"} हूँ।`;
  const why = cold ? "आपको हमारी properties के बारे में बताने के लिए call किया है" : `आपने ${project || "property"} के बारे में enquiry की थी`;
  // Company script → it decides the flow. Default flow starts by asking the language preference.
  if (hasScript || !askLanguage) return `${hello} ${why} — क्या अभी एक मिनट बात कर सकते हैं?`;
  return `${hello} ${why}। आप Hindi में बात करना चाहेंगे या English में?`;
}

module.exports = {
  resolve,
  isConfigured,
  missing,
  normalizeLanguage,
  confirmationScript,
  reminderScript,
  enquiryScript,
  spokenDate,
  spokenTime,
  plivo,
  publicBase,
  webhookSecret,
  agentName,
  agentGender,
  elevenLabs,
  COUNTRY_LANG,
  LANG_LABEL,
  STT_LANG,
  CODE_LANGUAGE,
};
