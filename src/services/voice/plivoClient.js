const axios = require('axios');
const platformVoice = require('../../config/voiceAgents');

/** Minimal Plivo Voice REST client + XML helpers. */
const API = 'https://api.plivo.com/v1/Account';

/** Plivo wants numbers with country code and without "+" (e.g. 919812345678). */
function plivoNumber(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 10) return `91${d}`;
  if (d.length === 11 && d.startsWith('0')) return `91${d.slice(1)}`;
  return d;
}

function client() {
  const creds = platformVoice.plivo();
  if (!creds) throw new Error('Plivo is not configured (PLIVO_AUTH_ID / PLIVO_AUTH_TOKEN)');
  return {
    authId: creds.authId,
    http: axios.create({
      baseURL: `${API}/${creds.authId}`,
      auth: { username: creds.authId, password: creds.authToken },
      timeout: 15000,
    }),
  };
}

/**
 * Places an outbound call. Returns { requestUuid }.
 * answerUrl / hangupUrl must be public HTTPS URLs.
 */
async function makeCall({ from, to, answerUrl, hangupUrl, ringTimeout = 40, timeLimit = 300 }) {
  const { http } = client();
  const { data } = await http.post('/Call/', {
    from: plivoNumber(from),
    to: plivoNumber(to),
    answer_url: answerUrl,
    answer_method: 'POST',
    hangup_url: hangupUrl,
    hangup_method: 'POST',
    fallback_url: hangupUrl ? hangupUrl.replace('/hangup/', '/fallback/') : undefined,
    fallback_method: 'POST',
    ring_timeout: ringTimeout,
    time_limit: timeLimit,
  });
  return { requestUuid: data.request_uuid || null, message: data.message || '' };
}

/** Ends a live call (real-time engine: after the agent's goodbye). */
async function hangupCall(callUuid) {
  const { http } = client();
  await http.delete(`/Call/${encodeURIComponent(callUuid)}/`);
}

/**
 * Moves a live call to another XML URL (used to fall back to the classic
 * engine when the real-time audio stream could not connect).
 */
async function transferCall(callUuid, url) {
  const { http } = client();
  await http.post(`/Call/${encodeURIComponent(callUuid)}/`, { legs: 'aleg', aleg_url: url, aleg_method: 'POST' });
}

/** Readable message out of a Plivo API error. */
function errorText(err) {
  const d = err.response?.data;
  if (d && typeof d === 'object') return d.error || d.message || JSON.stringify(d).slice(0, 200);
  if (typeof d === 'string' && d) return d.slice(0, 200);
  return err.message;
}

/* ---------------- XML ---------------- */

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Plivo's own voice — used only if ElevenLabs is unavailable.
const FALLBACK_VOICE = { hi: ['Polly.Aditi', 'hi-IN'], en: ['Polly.Raveena', 'en-IN'], ar: ['Polly.Zeina', 'arb'] };

/** <Play> the ElevenLabs clip, or <Speak> with Plivo's voice when there is no clip. */
function sayXml({ audioUrl, text, language = 'hi' }) {
  if (audioUrl) return `<Play>${esc(audioUrl)}</Play>`;
  const [voice, lang] = FALLBACK_VOICE[language] || FALLBACK_VOICE.en;
  return `<Speak voice="${voice}" language="${lang}">${esc(text)}</Speak>`;
}

const HINTS = {
  hi: 'haan,haan ji,ha,nahi,nahin,confirm,aa jaunga,aa jaungi,aa jayenge,nahi aa paunga,aaj,kal,parso,subah,dopahar,shaam,baje,Sunday,Monday,Tuesday,Wednesday,Thursday,Friday,Saturday,ravivar,somvar,shanivar,next week,baad mein,busy,date change,time change',
  en: 'yes,no,confirm,okay,sure,today,tomorrow,morning,afternoon,evening,Sunday,Monday,Tuesday,Wednesday,Thursday,Friday,Saturday,next week,later,busy,reschedule',
  ar: 'نعم,لا,أكيد,غدا,اليوم',
};

/**
 * Rough length of a spoken prompt (seconds), so the listening window is long
 * enough to cover the prompt AND the customer's answer. Plivo's default
 * executionTimeout (15 s) is the total wait, so with a long opening line the
 * customer had only a few seconds left to reply — the agent "didn't listen".
 */
function promptSeconds(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  return Math.ceil(words * 0.42) + 1;
}

/**
 * Say something, then listen for the customer's answer.
 * mode "speech" → speech recognition (needs GetInput speech enabled on the Plivo account)
 * mode "dtmf"   → keypad (press 1 / 2); works on every account, used as the automatic fallback.
 * Only widely supported attributes are used (no speechModel: phone_call is not
 * available for every language and would make Plivo fail the call).
 */
function gatherXml({ actionUrl, noInputUrl, say, sttLanguage = 'en-IN', language = 'hi', mode = 'speech' }) {
  // Prompt time + ~10 s for the customer to start and finish answering (Plivo allows 5–60).
  const listenFor = Math.min(60, Math.max(Number(process.env.VOICE_LISTEN_SECONDS) || 10, 5) + promptSeconds(say?.text));
  const hints = HINTS[language] || HINTS.en;
  const endTimeout = process.env.VOICE_SPEECH_END_TIMEOUT || 'auto'; // 'auto' or 2-10 s of silence
  const attrs = mode === 'dtmf'
    ? `inputType="dtmf" numDigits="1" digitEndTimeout="5" executionTimeout="${Math.min(60, 8 + promptSeconds(say?.text))}"`
    : `inputType="speech" language="${esc(process.env.VOICE_STT_LANGUAGE || sttLanguage)}" executionTimeout="${listenFor}" speechEndTimeout="${esc(endTimeout)}" hints="${esc(hints)}" profanityFilter="false"`;
  return (
    '<?xml version="1.0" encoding="UTF-8"?><Response>' +
    `<GetInput action="${esc(actionUrl)}" method="POST" ${attrs} redirect="true">` +
    sayXml({ ...say, language }) +
    '</GetInput>' +
    `<Redirect method="POST">${esc(noInputUrl)}</Redirect>` +
    '</Response>'
  );
}

/** Say something and hang up. */
function hangupXml({ say, language = 'hi' } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${say ? sayXml({ ...say, language }) : ''}<Wait length="1"/><Hangup/></Response>`;
}

/** Short spoken acknowledgement, then fetch the real reply (it is still being prepared). */
function holdXml({ say, language = 'hi', nextUrl }) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${say ? sayXml({ ...say, language }) : ''}<Redirect method="POST">${esc(nextUrl)}</Redirect></Response>`;
}

/**
 * Real-time engine: connect the call's audio both ways to our WebSocket
 * (μ-law 8 kHz, the native phone format → no conversion, lowest delay).
 */
function streamXml({ wsUrl, maxSeconds = 900 }) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?><Response>' +
    `<Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-mulaw;rate=8000" streamTimeout="${Math.round(maxSeconds)}">${esc(wsUrl)}</Stream>` +
    '</Response>'
  );
}

module.exports = { makeCall, hangupCall, transferCall, streamXml, errorText, gatherXml, hangupXml, holdXml, plivoNumber, esc, promptSeconds };
