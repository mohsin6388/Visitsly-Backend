const logger = require("../../utils/logger");
const ApiError = require("../../utils/ApiError");

const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/*
 * Keep AI replies reasonably short for faster generation.
 * Can be overridden from environment if needed.
 */
const MAX_OUTPUT_TOKENS = Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 512);

/*
 * Gemini temporary failure retry configuration.
 *
 * Total attempts:
 *   Attempt 1 -> normal request
 *   Attempt 2 -> after 1 second
 *   Attempt 3 -> after 2 seconds
 *
 * IMPORTANT:
 * There is intentionally NO request timeout here.
 * Gemini is allowed to take as much time as it needs.
 */
const MAX_RETRIES = 2;

const RETRY_DELAYS_MS = [1000, 2000];

/*
 * HTTP statuses where retrying makes sense.
 *
 * 429 = rate limit
 * 500 = internal server error
 * 502 = bad gateway
 * 503 = service unavailable
 * 504 = gateway timeout
 */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

/**
 * Returns true if a Gemini HTTP response should be retried.
 */
function isRetryableStatus(status) {
  return RETRYABLE_STATUS_CODES.has(status);
}

/**
 * Wait helper.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calls Gemini's generateContent endpoint and returns
 * the model's raw text.
 *
 * Flow:
 *
 * conversationEngine
 *       ↓
 * generateStructured
 *       ↓
 * generateContent
 *       ↓
 * Gemini
 *       ↓
 * JSON response
 *
 * Retry behavior:
 *
 * Attempt 1
 *    ↓ temporary error
 * wait 1 sec
 *    ↓
 * Attempt 2
 *    ↓ temporary error
 * wait 2 sec
 *    ↓
 * Attempt 3
 *    ↓
 * success OR final error
 *
 * There is NO artificial timeout.
 *
 * @param {Object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.systemInstruction
 * @param {Array<{role: 'user'|'model', text: string}>} opts.history
 * @param {Object} [opts.responseSchema]
 * @param {number} [opts.temperature]
 */
async function generateContent({
  apiKey,
  systemInstruction,
  history = [],
  responseSchema,
  temperature = 0.8,
}) {
  if (!apiKey) {
    throw ApiError.badRequest(
      "No Gemini API key configured — add one in Settings before enabling AI conversations",
    );
  }

  const url = `${API_BASE}/${DEFAULT_MODEL}:generateContent?key=${apiKey}`;

  /*
   * Keep only valid conversation turns.
   *
   * This does NOT change the conversation flow.
   * It simply prevents empty/invalid history items
   * from being sent to Gemini.
   */
  const contents = Array.isArray(history)
    ? history
        .filter(
          (turn) =>
            turn &&
            (turn.role === "user" || turn.role === "model") &&
            typeof turn.text === "string" &&
            turn.text.trim().length > 0,
        )
        .map((turn) => ({
          role: turn.role,
          parts: [{ text: turn.text }],
        }))
    : [];

  const body = {
    system_instruction: {
      parts: [{ text: systemInstruction || "" }],
    },

    contents,

    /*
     * Keep only ONE generationConfig.
     *
     * 512 tokens is enough for our structured WhatsApp response
     * in the current flow and reduces unnecessary generation.
     */
    generationConfig: {
      temperature,
      maxOutputTokens: MAX_OUTPUT_TOKENS,

      ...(responseSchema
        ? {
            responseMimeType: "application/json",
            responseJsonSchema: responseSchema,
          }
        : {}),
    },
  };

  /*
   * ---------------------------------------------------------
   * GEMINI REQUEST + RETRIES
   * ---------------------------------------------------------
   */

  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const attemptNumber = attempt + 1;
    const startedAt = Date.now();

    /*
     * If this is a retry, wait before sending the request.
     */
    if (attempt > 0) {
      const delay =
        RETRY_DELAYS_MS[attempt - 1] ||
        RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];

      logger.warn("[gemini] Retrying Gemini request", {
        attempt: attemptNumber,
        maxAttempts: MAX_RETRIES + 1,
        delayMs: delay,
        model: DEFAULT_MODEL,
      });

      await sleep(delay);
    }

    let response;

    try {
      logger.info("[gemini] Sending request", {
        attempt: attemptNumber,
        maxAttempts: MAX_RETRIES + 1,
        model: DEFAULT_MODEL,
      });

      /*
       * IMPORTANT:
       *
       * NO AbortSignal.timeout() here.
       *
       * Gemini can take as much time as it needs.
       */
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      const duration = Date.now() - startedAt;

      lastError = err;

      logger.error("[gemini] Request failed", {
        attempt: attemptNumber,
        maxAttempts: MAX_RETRIES + 1,
        duration: `${duration}ms`,
        error: err.message,
        name: err.name,
        model: DEFAULT_MODEL,
      });

      /*
       * Network/fetch errors are considered temporary.
       *
       * Retry if attempts remain.
       */
      if (attempt < MAX_RETRIES) {
        continue;
      }

      throw ApiError.internal(
        "Failed to reach Gemini API after multiple attempts",
      );
    }

    const duration = Date.now() - startedAt;

    logger.info("[gemini] API response received", {
      attempt: attemptNumber,
      maxAttempts: MAX_RETRIES + 1,
      duration: `${duration}ms`,
      status: response.status,
      model: DEFAULT_MODEL,
    });

    /*
     * ---------------------------------------------------------
     * SUCCESS
     * ---------------------------------------------------------
     */

    if (response.ok) {
      let data;

      try {
        data = await response.json();
      } catch (err) {
        logger.error("[gemini] Failed to parse Gemini response JSON", {
          attempt: attemptNumber,
          duration: `${Date.now() - startedAt}ms`,
          error: err.message,
        });

        /*
         * Invalid JSON from a successful HTTP response is
         * generally not something we should blindly retry.
         */
        throw ApiError.internal("Invalid response received from Gemini");
      }

      const text =
        data?.candidates?.[0]?.content?.parts
          ?.map((part) => part?.text || "")
          .join("") || "";

      if (!text) {
        const blockReason = data?.promptFeedback?.blockReason;

        logger.warn("[gemini] Empty response from Gemini", {
          attempt: attemptNumber,
          duration: `${Date.now() - startedAt}ms`,
          blockReason,
          finishReason: data?.candidates?.[0]?.finishReason,
        });
      }

      logger.info("[gemini] Generation completed", {
        attempt: attemptNumber,
        duration: `${Date.now() - startedAt}ms`,
        outputLength: text.length,
        model: DEFAULT_MODEL,
      });

      return {
        text,
        raw: data,
      };
    }

    /*
     * ---------------------------------------------------------
     * GEMINI HTTP ERROR
     * ---------------------------------------------------------
     */

    const errText = await response.text().catch(() => "");

    const retryable = isRetryableStatus(response.status);

    logger.error("[gemini] Gemini API returned an error", {
      attempt: attemptNumber,
      maxAttempts: MAX_RETRIES + 1,
      duration: `${Date.now() - startedAt}ms`,
      status: response.status,
      retryable,
      body: errText,
      model: DEFAULT_MODEL,
    });

    /*
     * Retry only temporary errors.
     *
     * Example:
     * 503 -> retry
     * 429 -> retry
     * 500 -> retry
     *
     * But:
     * 400 -> don't retry
     * 401 -> don't retry
     * 403 -> don't retry
     */
    if (retryable && attempt < MAX_RETRIES) {
      continue;
    }

    /*
     * Final failure.
     */
    throw ApiError.internal(`Gemini API error (${response.status})`);
  }

  /*
   * This should theoretically never be reached because
   * the loop either returns or throws.
   */
  throw ApiError.internal(
    lastError?.message || "Gemini request failed after multiple attempts",
  );
}

/**
 * Convenience wrapper:
 * Calls generateContent with a JSON schema
 * and parses the result.
 */
async function generateStructured({
  apiKey,
  systemInstruction,
  history,
  responseSchema,
  temperature,
}) {
  const { text, raw } = await generateContent({
    apiKey,
    systemInstruction,
    history,
    responseSchema,
    temperature,
  });

  try {
    return {
      parsed: JSON.parse(text),
      raw,
    };
  } catch (err) {
    logger.error("[gemini] Failed to parse structured JSON response", {
      text: text.slice(0, 500),
      error: err.message,
    });

    throw ApiError.internal("AI returned an unparseable response");
  }
}

module.exports = {
  generateContent,
  generateStructured,
  DEFAULT_MODEL,
};
