const logger = require("../../utils/logger");

/**
 * Groq (OpenAI-compatible) — fallback LLM when Gemini is down / rate-limited.
 *
 * .env
 *   GROQ_API_KEY=gsk_...
 *   GROQ_MODELS=llama-3.3-70b-versatile,openai/gpt-oss-120b,llama-3.1-8b-instant   (optional, fallback order)
 */
const API_URL = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_MODELS = ["llama-3.3-70b-versatile", "openai/gpt-oss-120b", "llama-3.1-8b-instant"];
const cooldown = new Map(); // model -> until(ms)

function apiKey() {
  return String(process.env.GROQ_API_KEY || "").trim() || null;
}

function isConfigured() {
  return Boolean(apiKey());
}

function models() {
  const fromEnv = String(process.env.GROQ_MODELS || process.env.GROQ_MODEL || "")
    .split(/[,\s]+/)
    .map((m) => m.trim())
    .filter(Boolean);
  const all = [...new Set([...fromEnv, ...DEFAULT_MODELS])];
  const now = Date.now();
  return [...all.filter((m) => !(cooldown.get(m) > now)), ...all.filter((m) => cooldown.get(m) > now)];
}

/**
 * history: [{ role: "user" | "model" | "assistant", text }]
 * json: true → response_format json_object (the prompt must mention JSON).
 * Returns { text, model }. Throws when every model failed.
 */
async function chat({ systemInstruction = "", history = [], json = false, temperature = 0.6, maxTokens = 1024, timeoutMs = 15000, maxModels = 3, validateText } = {}) {
  const key = apiKey();
  if (!key) throw new Error("GROQ_API_KEY not configured");
  const messages = [];
  if (systemInstruction) messages.push({ role: "system", content: String(systemInstruction) });
  for (const t of history) {
    if (!t || typeof t.text !== "string" || !t.text.trim()) continue;
    messages.push({ role: t.role === "model" || t.role === "assistant" ? "assistant" : "user", content: t.text });
  }
  if (!messages.some((m) => m.role === "user")) messages.push({ role: "user", content: "Continue." });

  const failures = [];
  for (const model of models().slice(0, Math.max(1, maxModels))) {
    const startedAt = Date.now();
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages,
          temperature,
          max_tokens: maxTokens,
          ...(json ? { response_format: { type: "json_object" } } : {}),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        failures.push(`${model}:${res.status}`);
        logger.warn("[groq] API error", { model, status: res.status, body: body.slice(0, 300) });
        if (res.status === 401) break; // bad key — other models won't help
        if (res.status === 429) cooldown.set(model, Date.now() + 30000);
        if (res.status === 404 || (res.status === 400 && /model/i.test(body))) cooldown.set(model, Date.now() + 10 * 60000);
        continue;
      }
      const data = await res.json();
      const text = String(data?.choices?.[0]?.message?.content || "").trim();
      if (!text) {
        failures.push(`${model}:empty`);
        continue;
      }
      if (validateText) {
        try {
          validateText(text);
        } catch (err) {
          failures.push(`${model}:invalid`);
          continue;
        }
      }
      logger.info("[groq] Generation completed", { model, duration: `${Date.now() - startedAt}ms` });
      return { text, model: `groq:${model}` };
    } catch (err) {
      failures.push(`${model}:${err.name === "TimeoutError" ? "timeout" : "network"}`);
      logger.warn("[groq] Request failed", { model, error: err.message });
    }
  }
  const err = new Error(`Groq unavailable (${failures.join(", ")})`);
  err.groqFailures = failures;
  throw err;
}

/** Pulls the first JSON object out of a model reply (handles ```json fences). */
function extractJson(text) {
  const s = String(text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(s);
  } catch {
    const a = s.indexOf("{");
    const b = s.lastIndexOf("}");
    if (a >= 0 && b > a) return JSON.parse(s.slice(a, b + 1));
    throw new Error("No JSON in reply");
  }
}

module.exports = { chat, isConfigured, extractJson };
