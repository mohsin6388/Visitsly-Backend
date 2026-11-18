const crypto = require('crypto');
const VoiceAudio = require('../../models/VoiceAudio');
const logger = require('../../utils/logger');

/**
 * ElevenLabs text-to-speech for phone calls. Returns the id of a stored clip
 * (served at /api/webhooks/voice/audio/<id>.mp3) or null when ElevenLabs is
 * not set up / failed — the caller then falls back to Plivo's own voice.
 */
const TIMEOUT_MS = Number(process.env.ELEVENLABS_TIMEOUT_MS || 6000);
const memo = new Map(); // key -> id (small in-process cache)

function keyFor(tts, text) {
  return crypto.createHash('sha1').update(`${tts.voiceId}|${tts.modelId}|${text}`).digest('hex');
}

async function synthesize(tts, text, language, { timeoutMs = TIMEOUT_MS } = {}) {
  const clean = String(text || '').trim();
  if (!tts || !clean) return null;
  const key = keyFor(tts, clean);
  if (memo.has(key)) return memo.get(key);
  try {
    const existing = await VoiceAudio.findOne({ key }).select('_id').lean();
    if (existing) {
      memo.set(key, String(existing._id));
      return String(existing._id);
    }
  } catch { /* db hiccup — just generate */ }

  const startedAt = Date.now();
  const supportsLangCode = /v2_5|v3|flash|turbo/i.test(tts.modelId);
  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(tts.voiceId)}?output_format=mp3_22050_32`, {
      method: 'POST',
      headers: { 'xi-api-key': tts.apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({
        text: clean,
        model_id: tts.modelId,
        ...(supportsLangCode && language ? { language_code: language } : {}),
        voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0, use_speaker_boost: true },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn('[tts] ElevenLabs error', { status: res.status, body: body.slice(0, 300) });
      return null;
    }
    const data = Buffer.from(await res.arrayBuffer());
    if (!data.length) return null;
    const doc = await VoiceAudio.findOneAndUpdate(
      { key },
      { $setOnInsert: { key, data, text: clean.slice(0, 500), contentType: 'audio/mpeg', createdAt: new Date() } },
      { upsert: true, new: true, projection: { _id: 1 } },
    );
    const id = String(doc._id);
    memo.set(key, id);
    if (memo.size > 500) memo.delete(memo.keys().next().value);
    logger.info('[tts] ElevenLabs clip ready', { ms: Date.now() - startedAt, bytes: data.length });
    return id;
  } catch (err) {
    logger.warn('[tts] ElevenLabs failed', { error: err.message, ms: Date.now() - startedAt });
    return null;
  }
}

async function getClip(id) {
  if (!/^[a-f\d]{24}$/i.test(String(id || ''))) return null;
  return VoiceAudio.findById(id).select('data contentType').lean();
}

module.exports = { synthesize, getClip };
