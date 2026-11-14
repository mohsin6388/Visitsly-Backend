const logger = require("../../utils/logger");
const ApiError = require("../../utils/ApiError");

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/*
 * ---------------------------------------------------------------
 * MODEL CHAIN (fallback order)
 * ---------------------------------------------------------------
 * Gemini ke rate-limit (429) har model ke liye ALAG hote hain, aur 503
 * aksar ek hi model par aata hai. Isliye ek model fail ho to hum turant
 * agle model par chale jate hain — user ki baat rukti nahi.
 *
 * Priority:
 *   1. GEMINI_MODELS  (comma separated)   e.g. "gemini-3.5-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite"
 *   2. GEMINI_MODEL   (purana single model) — sirf tab jab wo shut-down 2.0 family ka na ho
 *   3. Defaults
 *
 * NOTE: gemini-2.0-flash / 2.0-flash-lite Google ne 1 June 2026 ko shut down kar diye.
 */
// Kam se kam 3 models: ek fail/busy ho to agla turant try hota hai.
// 404 wale (retire ho chuke) models apne-aap skip ho jate hain, isliye list safe hai.
const DEFAULT_CHAIN = [
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-2.5-flash",
];

function splitList(value) {
  return String(value || "")
    .split(/[,\s]+/)
    .map((m) => m.trim())
    .filter(Boolean);
}

function buildModelChain() {
  // GEMINI_MODELS aur GEMINI_MODEL dono me comma-separated list chalegi.
  // Shut-down 2.0 family ke models automatically hata diye jate hain.
  const chain = [
    ...splitList(process.env.GEMINI_MODELS),
    ...splitList(process.env.GEMINI_MODEL),
    ...DEFAULT_CHAIN,
  ].filter((m) => !m.startsWith("gemini-2.0"));

  return [...new Set(chain)];
}

const MODEL_CHAIN = buildModelChain();
const DEFAULT_MODEL = MODEL_CHAIN[0];
logger.info(`[gemini] Model chain: ${MODEL_CHAIN.join(" -> ")} (${process.env.GEMINI_ATTEMPTS_PER_MODEL || 2} attempts each)`);

/*
 * 3.x / 2.5 models "thinking" tokens bhi maxOutputTokens me count karte hain.
 * 512 me JSON beech me kat sakta tha (-> unparseable). Isliye default 2048.
 */
const MAX_OUTPUT_TOKENS = Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 2048);

// Optional: "minimal" | "low" | "medium" | "high" — set tabhi karo jab chahiye.
const THINKING_LEVEL = process.env.GEMINI_THINKING_LEVEL || null;

// Ek request ko max kitna wait karna hai (hang hone se baat na ruke).
const REQUEST_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 30000);

// Ek hi model par temporary error (503/500/timeout) pe kitni baar try karna hai.
const ATTEMPTS_PER_MODEL = Number(process.env.GEMINI_ATTEMPTS_PER_MODEL || 2);
const SAME_MODEL_RETRY_DELAY_MS = 800;

// Cooldowns: fail hue model ko kuch der skip karte hain taaki har message
// pe time waste na ho.
const COOLDOWN_503_MS = 20 * 1000;
const COOLDOWN_429_MIN_MS = 30 * 1000;
const COOLDOWN_429_DAILY_MS = 10 * 60 * 1000;
const COOLDOWN_404_MS = 10 * 60 * 1000;

const modelCooldownUntil = new Map(); // model -> timestamp(ms)

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isOnCooldown(model) {
  return (modelCooldownUntil.get(model) || 0) > Date.now();
}

function setCooldown(model, ms) {
  modelCooldownUntil.set(model, Date.now() + ms);
}

/** Gemini 429 body se "retryDelay": "12s" nikalta hai (ms me). */
function parseRetryDelayMs(bodyText) {
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(bodyText || "");
  return m ? Math.ceil(Number(m[1]) * 1000) : null;
}

/** Order: pehle jo cooldown me nahi, phir baaki (kabhi bhi bina try kiye fail nahi karte). */
function orderedModels() {
  const ready = MODEL_CHAIN.filter((m) => !isOnCooldown(m));
  const cooling = MODEL_CHAIN.filter((m) => isOnCooldown(m)).sort(
    (a, b) => modelCooldownUntil.get(a) - modelCooldownUntil.get(b),
  );
  return [...ready, ...cooling];
}

function normalizeHistory(history) {
  return Array.isArray(history)
    ? history
        .filter(
          (turn) =>
            turn &&
            (turn.role === "user" || turn.role === "model") &&
            typeof turn.text === "string" &&
            turn.text.trim().length > 0,
        )
        .map((turn) => ({ role: turn.role, parts: [{ text: turn.text }] }))
    : [];
}

function buildBody({
  systemInstruction,
  contents,
  responseSchema,
  temperature,
  includeTemperature,
}) {
  const generationConfig = {
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    ...(includeTemperature && typeof temperature === "number"
      ? { temperature }
      : {}),
    ...(THINKING_LEVEL
      ? { thinkingConfig: { thinkingLevel: THINKING_LEVEL } }
      : {}),
    ...(responseSchema
      ? {
          responseMimeType: "application/json",
          responseJsonSchema: responseSchema,
        }
      : {}),
  };

  return {
    system_instruction: { parts: [{ text: systemInstruction || "" }] },
    contents,
    generationConfig,
  };
}

/**
 * Ek model par ek request. Result:
 *   { ok: true, text, raw }
 *   { ok: false, action, status, reason }
 * action = "retry_same" | "next_model" | "fatal" | "drop_temperature"
 */
async function callModel({ model, apiKey, body, validateText }) {
  const url = `${API_BASE}/${model}:generateContent`;
  const startedAt = Date.now();

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey, // key URL me nahi — logs me leak nahi hoti
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    logger.error("[gemini] Request failed", {
      model,
      duration: `${Date.now() - startedAt}ms`,
      error: err.message,
      timedOut,
    });
    return {
      ok: false,
      action: "retry_same",
      status: timedOut ? "timeout" : "network",
      reason: err.message,
    };
  }

  const duration = `${Date.now() - startedAt}ms`;

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    const status = response.status;

    logger.error("[gemini] API error", {
      model,
      status,
      duration,
      body: errText.slice(0, 600),
    });

    // 400 + temperature/top_p/top_k complaint -> bina temperature ke dobara
    if (status === 400 && /temperature|top_p|top_k/i.test(errText)) {
      return { ok: false, action: "drop_temperature", status, reason: errText };
    }

    // 429: rate-limit / quota. Wait karne ki jagah seedha dusre model par.
    if (status === 429) {
      const daily = /PerDay|per day|daily/i.test(errText);
      const retryMs = parseRetryDelayMs(errText);
      setCooldown(
        model,
        daily
          ? COOLDOWN_429_DAILY_MS
          : Math.max(retryMs || 0, COOLDOWN_429_MIN_MS),
      );
      return {
        ok: false,
        action: "next_model",
        status,
        reason: "rate limited",
      };
    }

    // 404: model exist nahi karta / shut down ho gaya
    if (status === 404) {
      setCooldown(model, COOLDOWN_404_MS);
      return {
        ok: false,
        action: "next_model",
        status,
        reason: "model not found",
      };
    }

    // 500/502/503/504: temporary
    if ([500, 502, 503, 504].includes(status)) {
      return { ok: false, action: "retry_same", status, reason: "server busy" };
    }

    // 400 / 401 / 403 etc: config problem — dusre model se bhi theek nahi hoga
    // (403 kabhi kabhi model-specific hota hai, isliye usko next_model rakha)
    if (status === 403) {
      return { ok: false, action: "next_model", status, reason: "forbidden" };
    }
    // 400 jo model naam ki wajah se hai -> agla model try karo
    if (status === 400 && /model/i.test(errText)) {
      setCooldown(model, COOLDOWN_404_MS);
      return {
        ok: false,
        action: "next_model",
        status,
        reason: "bad model name",
      };
    }
    return {
      ok: false,
      action: "fatal",
      status,
      reason: errText.slice(0, 300),
    };
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    logger.error("[gemini] Invalid JSON from Gemini", {
      model,
      error: err.message,
    });
    return { ok: false, action: "retry_same", status: 200, reason: "bad json" };
  }

  const text =
    data?.candidates?.[0]?.content?.parts
      ?.map((part) => part?.text || "")
      .join("") || "";

  if (!text) {
    logger.warn("[gemini] Empty response", {
      model,
      duration,
      blockReason: data?.promptFeedback?.blockReason,
      finishReason: data?.candidates?.[0]?.finishReason,
    });
    return {
      ok: false,
      action: "retry_same",
      status: 200,
      reason: "empty response",
    };
  }

  if (validateText) {
    try {
      validateText(text);
    } catch (err) {
      logger.warn("[gemini] Response failed validation", {
        model,
        finishReason: data?.candidates?.[0]?.finishReason,
        error: err.message,
      });
      return {
        ok: false,
        action: "retry_same",
        status: 200,
        reason: "invalid output",
      };
    }
  }

  logger.info("[gemini] Generation completed", {
    model,
    duration,
    outputLength: text.length,
  });

  return { ok: true, text, raw: data };
}

/**
 * Gemini generateContent — multi-model fallback ke saath.
 *
 * Flow:
 *   model 1 -> (503? 1 retry) -> (429? seedha skip) -> model 2 -> model 3 ...
 *
 * @param {Object}   opts
 * @param {string}   opts.apiKey
 * @param {string}   opts.systemInstruction
 * @param {Array}    opts.history
 * @param {Object}   [opts.responseSchema]
 * @param {number}   [opts.temperature]
 * @param {Function} [opts.validateText]  text invalid ho to throw kare -> next model
 */
async function generateContent({
  apiKey,
  systemInstruction,
  history = [],
  responseSchema,
  temperature = 0.8,
  validateText,
}) {
  if (!apiKey) {
    throw ApiError.badRequest(
      "No Gemini API key configured — add one in Settings before enabling AI conversations",
    );
  }

  const contents = normalizeHistory(history);
  let includeTemperature = true;
  const failures = [];

  for (const model of orderedModels()) {
    for (let attempt = 1; attempt <= ATTEMPTS_PER_MODEL; attempt++) {
      const body = buildBody({
        systemInstruction,
        contents,
        responseSchema,
        temperature,
        includeTemperature,
      });

      logger.info("[gemini] Sending request", { model, attempt });

      let result = await callModel({ model, apiKey, body, validateText });

      // Temperature support nahi -> bina temperature ke ek baar aur
      if (!result.ok && result.action === "drop_temperature") {
        includeTemperature = false;
        result = await callModel({
          model,
          apiKey,
          body: buildBody({
            systemInstruction,
            contents,
            responseSchema,
            temperature,
            includeTemperature,
          }),
          validateText,
        });
      }

      if (result.ok) {
        return { text: result.text, raw: result.raw, model };
      }

      failures.push(`${model}:${result.status}`);

      if (result.action === "fatal") {
        throw ApiError.internal(
          `Gemini API error (${result.status}) — ${result.reason}`,
        );
      }

      if (result.action === "retry_same" && attempt < ATTEMPTS_PER_MODEL) {
        await sleep(SAME_MODEL_RETRY_DELAY_MS * attempt);
        continue;
      }

      // retry_same ke attempts khatam / next_model -> is model ko thodi der rest do
      if (result.action === "retry_same") {
        setCooldown(model, COOLDOWN_503_MS);
      }
      logger.warn("[gemini] Switching to next model", {
        from: model,
        reason: result.reason,
        status: result.status,
      });
      break;
    }
  }

  logger.error("[gemini] All models failed", { failures });
  const err = ApiError.internal(
    `Gemini unavailable on all models (${failures.join(", ")})`,
  );
  err.geminiFailures = failures;
  throw err;
}

/**
 * JSON schema ke saath call + parse. Invalid/adhoora JSON aaye to
 * agla model try hota hai.
 */
async function generateStructured({
  apiKey,
  systemInstruction,
  history,
  responseSchema,
  temperature,
}) {
  const { text, raw, model } = await generateContent({
    apiKey,
    systemInstruction,
    history,
    responseSchema,
    temperature,
    validateText: (t) => JSON.parse(t),
  });

  return { parsed: JSON.parse(text), raw, model };
}

module.exports = {
  generateContent,
  generateStructured,
  DEFAULT_MODEL,
  MODEL_CHAIN,
};
