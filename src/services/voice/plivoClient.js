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

/** Say something, then listen for the customer's answer (speech). */
function gatherXml({ actionUrl, noInputUrl, say, sttLanguage = 'hi-IN', language = 'hi' }) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?><Response>' +
    `<GetInput action="${esc(actionUrl)}" method="POST" inputType="speech" language="${esc(sttLanguage)}" speechModel="phone_call" executionTimeout="12" speechEndTimeout="auto" hints="${esc(HINTS[language] || HINTS.en)}" redirect="true" log="true">` +
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

module.exports = { makeCall, errorText, gatherXml, hangupXml, plivoNumber, esc };
