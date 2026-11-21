/* eslint-disable no-console */
/**
 * Real-time call engine smoke test — no database, no real providers.
 * A fake Deepgram server + mocked Gemini / ElevenLabs / Plivo drive a whole
 * call: opening → customer speaks → streamed reply → interruption → goodbye → hang-up.
 *   npm run test:voice
 */
const path = require('path');
const assert = require('assert');
const { WebSocketServer } = require('ws');
const { EventEmitter } = require('events');

const root = path.join(__dirname, '..');
process.env.DEEPGRAM_API_KEY = 'test';
process.env.ELEVENLABS_API_KEY = 'test';
process.env.ELEVENLABS_VOICE_ID = 'voice';
process.env.GEMINI_API_KEY = 'test';
process.env.VOICE_SILENCE_MS = '3000';

// ---- stub the database models used by the session ----
const CallLog = require(path.join(root, 'src/models/CallLog'));
const VoiceAudio = require(path.join(root, 'src/models/VoiceAudio'));
const saved = { turns: null, extracted: null };
CallLog.updateOne = async (q, u) => {
  if (u.$set?.turns) saved.turns = u.$set.turns;
  if (u.$set?.extracted) saved.extracted = u.$set.extracted;
  return { modifiedCount: 1 };
};
VoiceAudio.findOne = () => ({ select: () => ({ lean: async () => null }) });
VoiceAudio.updateOne = async () => ({});
const settingsService = require(path.join(root, 'src/services/settings/settingsService'));
settingsService.getGeminiKey = async () => 'test';
const plivo = require(path.join(root, 'src/services/voice/plivoClient'));
let hungUp = false;
plivo.hangupCall = async () => { hungUp = true; };

// ---- mocked HTTP providers ----
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const replies = [
  'जी बिल्कुल, बहुत बढ़िया! तो मैं आपकी visit कल ग्यारह बजे के लिए confirm कर देती हूँ। Location मैं WhatsApp पर भेज दूँगी।',
  'अच्छा, कोई बात नहीं। आप बताइए, कौन सा दिन आपके लिए ठीक रहेगा?',
  'ठीक है, शनिवार ग्यारह बजे note कर लिया। धन्यवाद, आपका दिन शुभ हो! [END]',
];
let llmCalls = 0;
function stream(chunks, delays) {
  return new ReadableStream({
    async start(c) {
      for (let i = 0; i < chunks.length; i += 1) {
        await sleep(delays[i]);
        c.enqueue(chunks[i]);
      }
      c.close();
    },
  });
}
global.fetch = async (url, opts = {}) => {
  url = String(url);
  if (opts.signal?.aborted) throw new Error('aborted');
  if (url.includes(':streamGenerateContent')) {
    const text = replies[Math.min(llmCalls, replies.length - 1)];
    llmCalls += 1;
    const words = text.split(' ');
    const enc = new TextEncoder();
    const chunks = [];
    for (let i = 0; i < words.length; i += 4) {
      chunks.push(enc.encode(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: `${words.slice(i, i + 4).join(' ')} ` }] } }] })}\n\n`));
    }
    return { ok: true, status: 200, body: stream(chunks, chunks.map((_, i) => (i === 0 ? 350 : 60))) };
  }
  if (url.includes(':generateContent')) {
    const body = JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ visit: 'reschedule', new_date: '2099-01-03', new_time: '11:00', summary: 'Rescheduled to Saturday 11 am.' }) }] }, finishReason: 'STOP' }] });
    return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) };
  }
  if (url.includes('api.elevenlabs.io')) {
    const audio = new Uint8Array(4000).fill(0x7f);
    return { ok: true, status: 200, body: stream([audio.slice(0, 2000), audio.slice(2000)], [180, 80]) };
  }
  throw new Error(`unexpected fetch ${url}`);
};

// ---- fake Deepgram ----
const dg = new WebSocketServer({ port: 0 });
let dgSocket = null;
let audioBytes = 0;
dg.on('connection', (ws) => {
  dgSocket = ws;
  ws.on('message', (m, binary) => { if (binary) audioBytes += m.length; });
});
const say = (text, { final = true, speechFinal = true } = {}) => dgSocket.send(JSON.stringify({ type: 'Results', is_final: final, speech_final: speechFinal, channel: { alternatives: [{ transcript: text }] } }));

(async () => {
  await new Promise((r) => { dg.on('listening', r); });
  process.env.DEEPGRAM_WS_URL = `ws://127.0.0.1:${dg.address().port}/v1/listen`;
  const { RealtimeCall, takeSentence, cleanSpoken } = require(path.join(root, 'src/services/voice/realtime/session'));

  // unit checks
  assert.deepStrictEqual(takeSentence('नमस्ते जी। आप कैसे', { first: true }), ['नमस्ते जी। ', 'आप कैसे']);
  assert.strictEqual(takeSentence('hello there', { first: false }), null);
  assert.strictEqual(cleanSpoken('धन्यवाद! [END]'), 'धन्यवाद!');

  // fake Plivo socket
  const plivoWs = new EventEmitter();
  plivoWs.readyState = 1;
  const out = [];
  plivoWs.send = (m) => out.push(JSON.parse(m));
  plivoWs.close = () => {};
  const from = (plivoEvent) => plivoWs.emit('message', Buffer.from(JSON.stringify(plivoEvent)));
  const last = (event) => [...out].reverse().find((m) => m.event === event);

  const log = {
    _id: '6afea332db894df84aad9e2a', ownerId: 'o', callUuid: 'uuid-1', turns: [],
    context: { purpose: 'visit_confirmation', orgId: 'org', name: 'Ravi', company: 'ABC Realty', project: 'Green Park', visitDate: '2099-01-01', visitTime: '11:00', visitDay: 'tomorrow', language: 'hi', opening: 'नमस्ते रवि जी, मैं ABC Realty से प्रिया बोल रही हूँ। कल ग्यारह बजे आपकी Green Park की visit है, आप आ पाएँगे?' },
  };
  const call = new RealtimeCall(plivoWs, log);
  from({ event: 'start', start: { callId: 'uuid-1', streamId: 'stream-1' } });
  await sleep(400);
  assert(out.some((m) => m.event === 'playAudio'), 'opening audio was sent');
  assert.strictEqual(last('checkpoint').name, 'opening');
  for (let i = 0; i < 20; i += 1) from({ event: 'media', media: { payload: Buffer.alloc(160, 0xff).toString('base64') } });
  from({ event: 'playedStream', name: 'opening' });
  await sleep(100);
  assert(audioBytes >= 3200, 'call audio reached speech-to-text');

  // 1) customer answers → streamed reply
  let n = out.length;
  say('हाँ जी', { final: false, speechFinal: false });
  say('हाँ जी, मैं कल आ जाऊँगा');
  const t0 = Date.now();
  while (!out.slice(n).some((m) => m.event === 'playAudio') && Date.now() - t0 < 3000) await sleep(10);
  const firstAudioMs = Date.now() - t0;
  console.log(`  first reply audio after ${firstAudioMs} ms (mock: LLM 350 ms + TTS 180 ms)`);
  assert(firstAudioMs < 900, 'agent starts speaking fast');
  await sleep(1200);
  assert(last('checkpoint').name.startsWith('reply-'), 'reply ends with a checkpoint');

  // 2) customer interrupts while the agent is still talking
  n = out.length;
  say('नहीं नहीं रुकिए', { final: false, speechFinal: false });
  await sleep(50);
  assert(out.slice(n).some((m) => m.event === 'clearAudio'), 'agent audio cleared on interruption');
  say('नहीं नहीं रुकिए, कल नहीं हो पाएगा');
  await sleep(1500);
  from({ event: 'playedStream', name: last('checkpoint').name });

  // 3) new date → goodbye with [END] → hang-up
  say('शनिवार ग्यारह बजे ठीक रहेगा');
  await sleep(1500);
  from({ event: 'playedStream', name: last('checkpoint').name });
  await sleep(700);
  assert(hungUp, 'call hung up after the goodbye');
  await call.finish('test');
  console.log('  transcript:');
  for (const t of saved.turns) console.log(`    ${t.role.padEnd(8)} ${t.text}`);
  assert(saved.turns.some((t) => t.role === 'agent' && t.text.endsWith('…')), 'interrupted reply marked as cut off');
  assert(!saved.turns.some((t) => /\[END\]/.test(t.text)), 'END tag never saved or spoken');
  assert.strictEqual(saved.extracted?.visit, 'reschedule');
  assert.strictEqual(saved.extracted?.new_date, '2099-01-03');
  console.log('✓ real-time call engine smoke test passed');
  dg.close();
  process.exit(0);
})().catch((err) => {
  console.error('✗', err);
  process.exit(1);
});
