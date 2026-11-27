/**
 * Customer voice notes → text, so the AI can answer what was actually said.
 * Downloads the audio from Meta (tenant context = the company's WhatsApp
 * token) and asks Gemini to transcribe it. Best effort: on any failure the
 * caller keeps the old "(customer sent a voice note)" text.
 */
const settingsService = require("../settings/settingsService");
const logger = require("../../utils/logger");

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const MAX_BYTES = 10 * 1024 * 1024; // WhatsApp voice notes are tiny; skip anything huge
const TIMEOUT_MS = 25 * 1000;
// Same model chain as the chat AI (GEMINI_MODELS / GEMINI_MODEL + defaults);
// GEMINI_AUDIO_MODELS can override it just for voice notes.
function models() {
  const own = String(process.env.GEMINI_AUDIO_MODELS || "").split(/[,\s]+/).filter(Boolean);
  return own.length ? own : require("./geminiClient").MODEL_CHAIN.slice(0, 3);
}

const PROMPT =
  "Transcribe this WhatsApp voice note from a property buyer exactly as spoken. " +
  "Keep the original language and script the speaker used (Hindi may be written in Devanagari, " +
  "Hinglish in Roman letters). Return only the transcript text, no notes. " +
  "If nothing can be understood, return an empty string.";

async function transcribeOnce({ apiKey, model, base64, mimeType }) {
  const res = await fetch(`${API_BASE}/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ inline_data: { mime_type: mimeType, data: base64 } }, { text: PROMPT }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 800 },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const data = await res.json();
  const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
  return text;
}

/**
 * @param {{ mediaId: string, mimeType?: string }} opts
 * @returns {Promise<string>} transcript ('' when not available)
 */
async function transcribeVoiceNote({ mediaId, mimeType }) {
  if (!mediaId) return "";
  try {
    const apiKey = await settingsService.getGeminiKey();
    if (!apiKey) return "";
    const { downloadFromMeta } = require("../whatsapp/mediaService");
    const file = await downloadFromMeta(mediaId);
    if (!file?.buffer?.length || file.buffer.length > MAX_BYTES) return "";
    // "audio/ogg; codecs=opus" → "audio/ogg" (Gemini wants the bare type).
    const type = String(file.mimeType || mimeType || "audio/ogg").split(";")[0].trim() || "audio/ogg";
    const base64 = file.buffer.toString("base64");
    for (const model of models()) {
      try {
        const text = await transcribeOnce({ apiKey, model, base64, mimeType: type });
        return text.slice(0, 2000);
      } catch (err) {
        logger.warn("[voice-note] transcription failed on a model, trying next", { model, error: err.message });
      }
    }
  } catch (err) {
    logger.warn("[voice-note] could not transcribe voice note", { error: err.message });
  }
  return "";
}

module.exports = { transcribeVoiceNote };
