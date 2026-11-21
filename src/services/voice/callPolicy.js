/**
 * Who may be called, from which region, when — and plain reasons when not.
 *
 *  Regions (picked from the customer's number):
 *    IN  India  — ON. Calling hours = AI calling → Settings (India time).
 *                 DND numbers are skipped when a DND check API is set up.
 *    AE  UAE    — separate process, OFF until the platform switches it on:
 *                 VOICE_UAE_ENABLED=true and a UAE caller number in
 *                 PLIVO_FROM_NUMBERS_JSON ({"IN":"+91…","AE":"+971…"}).
 *                 Hours in Gulf time: VOICE_UAE_CALL_HOURS=10-19 (default).
 *                 The agent speaks English, Arabic when the customer chose it.
 *
 *  DND (India): Settings → AI calling → DND check. The API URL contains
 *  {phone}; the JSON answer is read for dnd / isDnd / is_dnd / dnd_status /
 *  status / registered. Results are cached on the lead for 7 days.
 */
const axios = require("axios");
const Lead = require("../../models/Lead");
const Conversation = require("../../models/Conversation");
const logger = require("../../utils/logger");

const REGION = {
  IN: { code: "IN", label: "India", timezone: "Asia/Kolkata", languages: ["hi", "en"], defaultLanguage: "hi" },
  AE: { code: "AE", label: "UAE", timezone: "Asia/Dubai", languages: ["en", "ar"], defaultLanguage: "en" },
};

const DND_CACHE_MS = 7 * 24 * 3600 * 1000;

/** IN for +91 / 10-digit numbers, AE for +971, otherwise the company's country. */
function regionForPhone(phone, orgCountry = "IN") {
  const d = String(phone || "").replace(/\D/g, "");
  if (d.startsWith("971")) return "AE";
  if (d.length === 10 || (d.startsWith("91") && d.length === 12)) return "IN";
  return String(orgCountry || "IN").toUpperCase() === "AE" ? "AE" : "IN";
}

function uaeHours() {
  const m = String(process.env.VOICE_UAE_CALL_HOURS || "10-19").match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
  const start = m ? Math.min(23, Number(m[1])) : 10;
  const end = m ? Math.min(24, Number(m[2])) : 19;
  return { start, end };
}

/** Is calling switched on for this region? */
function regionEnabled(region) {
  if (region === "AE") {
    if (String(process.env.VOICE_UAE_ENABLED || "").toLowerCase() !== "true") return false;
    const map = (() => {
      try {
        return JSON.parse(process.env.PLIVO_FROM_NUMBERS_JSON || "{}") || {};
      } catch {
        return {};
      }
    })();
    return Boolean(map.AE);
  }
  return true;
}

function hourIn(timezone) {
  try {
    const h = parseInt(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: timezone }).format(new Date()), 10);
    return h === 24 ? 0 : h;
  } catch {
    return new Date().getUTCHours();
  }
}

/** Calling hours for a region. India uses the company's own hours (Settings). */
function hoursFor(region, settings) {
  if (region === "AE") return uaeHours();
  const cfg = settings?.visitConfirm || {};
  return {
    start: Number.isFinite(cfg.callStartHour) ? cfg.callStartHour : 10,
    end: Number.isFinite(cfg.callEndHour) ? cfg.callEndHour : 19,
  };
}

function inHours(region, settings) {
  const { start, end } = hoursFor(region, settings);
  const h = hourIn(REGION[region]?.timezone || "Asia/Kolkata");
  return h >= start && h < end;
}

function localHour(at, timezone) {
  try {
    return parseInt(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: timezone }).format(at), 10) % 24;
  } catch {
    return at.getUTCHours();
  }
}

/**
 * Next moment inside the region's calling hours, at least `minDelayMs` from
 * now. preferredHour (local) is honoured within the first day if possible.
 */
function nextCallTime(region, settings, minDelayMs = 0, preferredHour = null) {
  const tz = REGION[region]?.timezone || "Asia/Kolkata";
  const { start, end } = hoursFor(region, settings);
  const at = new Date(Date.now() + Math.max(0, minDelayMs));
  for (let i = 0; i < 72; i += 1) {
    const h = localHour(at, tz);
    const wantOk = preferredHour == null || h >= preferredHour || i >= 24;
    if (h >= start && h < end && wantOk) return at;
    at.setTime(at.getTime() + 3600 * 1000);
    at.setMinutes(5, 0, 0);
  }
  return at;
}

/** Language the call should use in this region (chat language when supported). */
function callLanguage(region, chatLanguage) {
  const r = REGION[region] || REGION.IN;
  const v = String(chatLanguage || "").toLowerCase();
  const code = /arabic|^ar\b/.test(v) ? "ar" : /english|^en\b/.test(v) ? "en" : /hindi|hinglish|^hi\b/.test(v) ? "hi" : null;
  return code && r.languages.includes(code) ? code : r.defaultLanguage;
}

/** Customer said STOP / opted out anywhere → never call. */
async function isOptedOut(lead) {
  if (!lead) return false;
  if (lead.optedOut) return true;
  return Boolean(await Conversation.exists({ leadId: lead._id, optedOut: true }));
}

function readDndAnswer(data) {
  if (data == null) return null;
  if (typeof data === "boolean") return data;
  const flat = typeof data === "object" ? { ...data, ...(data.data && typeof data.data === "object" ? data.data : {}), ...(data.result && typeof data.result === "object" ? data.result : {}) } : { status: data };
  for (const k of ["dnd", "isDnd", "is_dnd", "isDND", "DND", "registered", "is_registered"]) {
    if (typeof flat[k] === "boolean") return flat[k];
    if (typeof flat[k] === "string") return /^(true|yes|y|1|dnd|registered)$/i.test(flat[k].trim());
    if (typeof flat[k] === "number") return flat[k] === 1;
  }
  for (const k of ["dnd_status", "dndStatus", "status", "preference"]) {
    if (typeof flat[k] === "string") {
      const s = flat[k].toLowerCase();
      if (/non[-_ ]?dnd|not[-_ ]?registered|not[-_ ]?dnd|clean|allowed/.test(s)) return false;
      if (/dnd|registered|blocked|fully|partial/.test(s)) return true;
    }
  }
  return null;
}

/**
 * India DND check. { dnd: true|false|null, reason }
 * null = not checked (no API set up). Throws never.
 */
async function checkDnd(lead, settings) {
  const cfg = settings?.calling?.dnd || {};
  if (!cfg.enabled || !cfg.apiUrl) return { dnd: null, reason: "DND check not set up" };
  const cached = lead?.dnd;
  if (cached?.checkedAt && Date.now() - new Date(cached.checkedAt).getTime() < DND_CACHE_MS && typeof cached.status === "boolean") {
    return { dnd: cached.status, reason: "cached" };
  }
  const digits = String(lead.phone || "").replace(/\D/g, "").slice(-10);
  const url = String(cfg.apiUrl).replace(/\{phone\}/g, encodeURIComponent(digits));
  try {
    const headers = {};
    if (cfg.apiKey) headers[cfg.apiKeyHeader || "Authorization"] = cfg.apiKey;
    const { data } = await axios.get(url, { headers, timeout: 8000 });
    const dnd = readDndAnswer(data);
    if (dnd === null) return { dnd: null, reason: "DND check gave an unknown answer", failed: true };
    await Lead.updateOne({ _id: lead._id }, { $set: { dnd: { status: dnd, checkedAt: new Date() } } }).catch(() => {});
    return { dnd, reason: "checked" };
  } catch (err) {
    logger.warn("[voice] DND check failed", { error: err.message });
    return { dnd: null, reason: `DND check failed: ${err.message}`, failed: true };
  }
}

/**
 * Can this lead be called now? { ok, region, reason }
 * reason is a short, client-friendly sentence shown in AI calling.
 */
async function canCall(lead, { settings, orgCountry = "IN", checkHours = true } = {}) {
  const region = regionForPhone(lead?.phone, orgCountry);
  if (!lead?.phone) return { ok: false, region, reason: "No phone number" };
  if (await isOptedOut(lead)) return { ok: false, region, reason: "Customer said STOP (opted out) — will not be called", code: "opted_out" };
  if (!regionEnabled(region)) return { ok: false, region, reason: `AI calling for ${REGION[region].label} numbers is switched off`, code: "region_off" };
  if (checkHours && !inHours(region, settings)) {
    const { start, end } = hoursFor(region, settings);
    return { ok: false, region, reason: `Outside ${REGION[region].label} calling hours (${start}:00–${end}:00)`, code: "hours" };
  }
  if (region === "IN") {
    const dnd = await checkDnd(lead, settings);
    if (dnd.dnd === true) return { ok: false, region, reason: "DND number (India) — call not placed", code: "dnd" };
    if (dnd.failed) return { ok: false, region, reason: `${dnd.reason} — call not placed`, code: "dnd_check_failed" };
  }
  return { ok: true, region };
}

/**
 * Plivo status / hang-up cause → a plain reason for the client.
 * Returns null when the call went fine.
 */
function friendlyCallError({ status, hangupCause, error } = {}) {
  const text = `${status || ""} ${hangupCause || ""} ${error || ""}`.toLowerCase();
  if (!text.trim()) return null;
  if (/opted out|stop/.test(text)) return "Customer said STOP — not called";
  if (/\bdnd\b|do not disturb|ndnc|ncpr/.test(text)) return "DND number — call not placed";
  if (/insufficient|balance|credit|low fund|payment required|402/.test(text)) return "Plivo balance finished — recharge the calling account";
  if (/unallocated|invalid[_ ]number|invalid number|number format|no[_ ]route|not a valid|incorrect number|bad number/.test(text)) return "Wrong / invalid number";
  if (/subscriber[_ ]absent|unreachable|not reachable|switched off|number[_ ]changed|out of service|network out of order|temporar/.test(text)) return "Number switched off / not reachable";
  if (/rejected|declined|call[_ ]rejected/.test(text)) return "Customer rejected the call";
  if (/busy/.test(text)) return "Number busy";
  if (/no[-_ ]?answer|not answered|timeout|no user response|ring/.test(text)) return "Call not picked up";
  if (/cancel/.test(text)) return "Call cancelled";
  if (/no result from the phone network/.test(text)) return "No result from the phone network";
  if (/^completed\b|normal[_ ]clearing|normal hangup/.test(text.trim())) return null;
  return error || hangupCause || status || null;
}

module.exports = {
  REGION,
  regionForPhone,
  regionEnabled,
  hoursFor,
  inHours,
  nextCallTime,
  callLanguage,
  isOptedOut,
  checkDnd,
  canCall,
  friendlyCallError,
  readDndAnswer,
};
