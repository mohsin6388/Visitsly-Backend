/**
 * Conversation-language rules (pure — no database, no AI).
 *
 *  E0  The customer's FIRST message is English (or can't be read) → ask once,
 *      in English: "Which language would you prefer to chat in?"
 *  E1  The first message is in another supported language → no question;
 *      reply in that language and script right away.
 *  E2  A language the customer chose is saved and locked.
 *  E3  An explicit request ("Hindi mein baat karo", "Speak in English",
 *      "Urdu mein jawab do") switches immediately and is saved.
 *  E4  No explicit choice yet → switch only after TWO consecutive real
 *      messages in another language. "ok / yes / thanks / 👍" and one-word
 *      messages never switch. A chosen language is never overridden by
 *      messages in another language.
 *  E5  The saved language is what every other message uses (see localize.js).
 */
const { SOURCES, isSupported } = require("./languages");
const { detectLanguage, parseLanguageRequest } = require("./detect");

const LOCKED = new Set([SOURCES.SELECTED, SOURCES.AGENT]);

/** How the saved language was decided; old chats without a source were locked. */
function sourceOf(saved) {
  if (!saved?.language) return null;
  return saved.source || SOURCES.SELECTED;
}

function isLocked(saved) {
  return LOCKED.has(sourceOf(saved));
}

/**
 * @param {object} p
 * @param {{language?:string|null, source?:string|null, promptedAt?:Date|null, promptAnsweredAt?:Date|null}} p.saved
 * @param {string[]} p.batch     customer messages of this turn (not answered yet), oldest → newest
 * @param {string[]} p.inbound   recent customer messages (incl. this turn), oldest → newest
 * @param {boolean}  p.firstTurn the customer has not written before this turn
 * @returns {{
 *   language: string|null, source: string|null, changed: boolean,
 *   reason: 'explicit'|'prompt_reply'|'first_message'|'ask'|'detected'|'auto_switch'|'kept'|'unknown',
 *   ask: boolean, promptAnswered: boolean
 * }}
 */
function decideLanguage({ saved = {}, batch = [], inbound = [], firstTurn = false } = {}) {
  const current = isSupported(saved.language) ? saved.language : null;
  const currentSource = sourceOf({ language: current, source: saved.source });
  const pending = Boolean(saved.promptedAt) && !saved.promptAnsweredAt;
  const texts = batch.map((t) => String(t || "")).filter((t) => t.trim());

  const result = (language, source, reason, extra = {}) => ({
    language,
    source,
    changed: language !== current || (language != null && source !== currentSource),
    reason,
    ask: false,
    promptAnswered: false,
    ...extra,
  });
  const keep = (reason = "kept", extra = {}) => ({ ...result(current, currentSource, reason, extra), changed: false });

  // E3 / E2: an explicit choice in this turn (newest message first) always wins.
  for (let i = texts.length - 1; i >= 0; i -= 1) {
    const asked = parseLanguageRequest(texts[i]);
    if (asked) return result(asked, SOURCES.SELECTED, "explicit", { promptAnswered: pending });
  }

  const turn = detectLanguage(texts.join("\n"));

  // The customer is answering our language question (asked once, E0).
  if (pending) {
    if (turn.language && turn.confident && !turn.neutral) {
      return result(turn.language, SOURCES.DETECTED, "prompt_reply", { promptAnswered: true });
    }
    return keep("kept"); // "ok" / 👍 → keep the provisional language, never ask again
  }

  if (!current) {
    if (firstTurn && !saved.promptedAt) {
      // E1: first message in a supported non-English language → use it, no question.
      if (turn.language && turn.confident && turn.language !== "English") {
        return result(turn.language, SOURCES.DETECTED, "first_message");
      }
      // E0: English (or unreadable: emoji, sticker, romanised text) → ask once.
      // English is used until the customer answers.
      return result("English", SOURCES.DETECTED, "ask", { ask: true });
    }
    // Older chat that never had a language saved: take what we can read.
    if (turn.language && turn.confident) return result(turn.language, SOURCES.DETECTED, "detected");
    return keep("unknown");
  }

  // E2: chosen by the customer / set by the team → only an explicit request changes it.
  if (isLocked({ language: current, source: currentSource })) return keep();

  // E4: two consecutive real customer messages in the same other language.
  const real = [];
  for (let i = inbound.length - 1; i >= 0 && real.length < 2; i -= 1) {
    const d = detectLanguage(inbound[i]);
    if (d.neutral || !d.language) continue; // "ok", "thanks", 👍, stickers never count
    real.push(d);
  }
  if (
    real.length === 2 &&
    real.every((d) => d.substantive && d.language === real[0].language) &&
    real[0].language !== current
  ) {
    return result(real[0].language, SOURCES.DETECTED, "auto_switch");
  }
  return keep();
}

module.exports = { decideLanguage, isLocked, sourceOf, LOCKED };
