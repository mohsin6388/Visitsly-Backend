const crypto = require('crypto');
const VoiceAudio = require('../../../models/VoiceAudio');
const logger = require('../../../utils/logger');

/**
 * ElevenLabs text-to-speech in phone format (μ-law 8 kHz), streamed: audio
 * bytes are forwarded to the call while the rest of the sentence is still
 * being generated. No MP3, no file download by Plivo.
 */
const FORMAT = 'ulaw_8000';
const memo = new Map(); // key -> Buffer (small in-process cache of fixed lines)

function body(cfg, text, language) {
  const supportsLangCode = /v2_5|v3|flash|turbo/i.test(cfg.modelId);
  return JSON.stringify({
    text,
    model_id: cfg.modelId,
    ...(supportsLangCode && language ? { language_code: language } : {}),
    voice_settings: {
      stability: Number(process.env.ELEVENLABS_STABILITY || 0.45),
      similarity_boost: 0.8,
      style: Number(process.env.ELEVENLABS_STYLE || 0.15),
      use_speaker_boost: true,
      speed: Number(process.env.ELEVENLABS_SPEED || 1.0),
    },
  });
}

/**
 * Streams one sentence. onAudio(Buffer) for every chunk. Resolves with the
 * number of bytes produced (0 on failure). Respects an AbortSignal.
 */
async function streamSentence(cfg, text, language, { signal, onAudio, timeoutMs = 8000 } = {}) {
  const clean = String(text || '').trim();
  if (!cfg || !clean) return 0;
  const startedAt = Date.now();
  const ctrl = new AbortController();
  const stop = () => ctrl.abort();
  signal?.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, timeoutMs);
  let bytes = 0;
  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(cfg.voiceId)}/stream?output_format=${FORMAT}`,
      {
        method: 'POST',
        headers: { 'xi-api-key': cfg.apiKey, 'Content-Type': 'application/json', Accept: 'audio/basic' },
        body: body(cfg, clean, language),
        signal: ctrl.signal,
      },
    );
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      logger.warn('[rt-tts] ElevenLabs error', { status: res.status, body: err.slice(0, 200) });
      return 0;
    }
    const reader = res.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      if (!bytes) logger.info('[rt-tts] first audio', { ms: Date.now() - startedAt });
      bytes += value.length;
      onAudio(Buffer.from(value));
    }
    return bytes;
  } catch (err) {
    if (!signal?.aborted) logger.warn('[rt-tts] stream failed', { error: err.message, ms: Date.now() - startedAt });
    return bytes;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
}

function keyFor(cfg, text) {
  return crypto.createHash('sha1').update(`${FORMAT}|${cfg.voiceId}|${cfg.modelId}|${text}`).digest('hex');
}

/**
 * Whole clip for a fixed line (opening, "can you hear me?", goodbye), cached
 * in memory and MongoDB so it plays instantly. Returns a Buffer or null.
 */
async function clip(cfg, text, language, { timeoutMs = 9000 } = {}) {
  const clean = String(text || '').trim();
  if (!cfg || !clean) return null;
  const key = keyFor(cfg, clean);
  if (memo.has(key)) return memo.get(key);
  try {
    const doc = await VoiceAudio.findOne({ key }).select('data').lean();
    if (doc?.data) {
      const buf = Buffer.from(doc.data.buffer || doc.data);
      remember(key, buf);
      return buf;
    }
  } catch { /* db hiccup — generate */ }
  const parts = [];
  const n = await streamSentence(cfg, clean, language, { onAudio: (b) => parts.push(b), timeoutMs });
  if (!n) return null;
  const buf = Buffer.concat(parts);
  remember(key, buf);
  VoiceAudio.updateOne(
    { key },
    { $setOnInsert: { key, data: buf, text: clean.slice(0, 500), contentType: 'audio/basic', createdAt: new Date() } },
    { upsert: true },
  ).catch(() => {});
  return buf;
}

function remember(key, buf) {
  memo.set(key, buf);
  if (memo.size > 300) memo.delete(memo.keys().next().value);
}

module.exports = { streamSentence, clip };
