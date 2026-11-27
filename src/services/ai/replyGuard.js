/**
 * Reply guard for the WhatsApp AI.
 *
 *  1. hasNewerInbound()  — called right before the AI sends a reply. If the
 *     customer wrote again while Gemini was thinking, this reply is dropped;
 *     the run for the newest message answers everything in one go. Exactly
 *     one message is ever "the newest" (ObjectId order), so one reply goes out.
 *
 *  2. checkInbound()     — called for every customer message before the AI:
 *       • bot-loop: the other side looks like a bot (menus, "didn't
 *         understand", auto-replies), floods (>5 msgs / minute) or repeats
 *         the same text → AI paused for this chat (status 'manual'), owner
 *         notified. The client resumes it from the AI inbox.
 *       • junk: emoji-only, keyboard mash, abuse or the same message again.
 *         After 3 in a row the AI stays quiet; a real message resets the
 *         streak and the AI replies again.
 */
const Conversation = require("../../models/Conversation");
const Message = require("../../models/Message");
const Notification = require("../../models/Notification");
const { emitToUser } = require("../../sockets");
const logger = require("../../utils/logger");

const FLOOD_WINDOW_MS = 60 * 1000;
const FLOOD_MAX = 5; // more than this many customer messages in a minute → bot / flood
const REPEAT_PAUSE = 3; // same text 3 times in a row → bot
const JUNK_LIMIT = 3; // 3 junk messages in a row → AI goes quiet

// Typical auto-reply / chatbot lines (English + Hindi/Hinglish).
const BOT_PATTERNS = [
  /\b(did ?n['’]?t|did not|could ?n['’]?t|could not|unable to) understand\b/i,
  /\binvalid (option|input|choice|selection|response|entry)\b/i,
  /\bplease (select|choose|pick|reply with|enter|type) (an? |the |one of the )?(valid )?(option|number|choice|menu)/i,
  /\b(reply|press|type|send|enter) \d\b.{0,25}\b(for|to)\b/i,
  /\b(this is an? |)(automated|auto[- ]?generated|auto[- ]?reply|automatic) (message|reply|response)\b/i,
  /\bmain menu\b|\bback to menu\b|\bselect an option\b/i,
  /\bwe (have )?received your (message|query|request)\b.{0,40}\b(shortly|soon|within)\b/i,
  /\b(our|the) (agent|executive|team) will (get back|contact|reach out)\b.{0,30}\b(shortly|soon|within)\b/i,
  /samajh nahi (aaya|paaya|paye)|sahi option (chun|select)|valid option/i,
  /^\s*sorry,? i (am|'m) (just )?a (bot|virtual assistant|chatbot)/i,
];

// A numbered menu: 3+ lines that start with "1." / "2)" / "3 -" / emoji numbers.
function looksLikeMenu(text) {
  const lines = String(text).split(/\n+/);
  const numbered = lines.filter((l) => /^\s*(\d{1,2}[.)\-:]|[1-9]️?⃣)\s*\S/.test(l));
  return numbered.length >= 3;
}

function looksLikeBot(text) {
  const t = String(text || "");
  if (!t.trim()) return false;
  return looksLikeMenu(t) || BOT_PATTERNS.some((re) => re.test(t));
}

// Common abuse (kept short; matched as whole words).
const ABUSE_RE = /\b(madarchod|bhenchod|behenchod|chutiya|chutiye|gandu|haramkhor|bsdk|bhosdike|bhosdi|lodu|lavde|randi|fuck|fucker|motherfucker|bitch|bastard|asshole)\b/i;

function normalize(text) {
  return String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** True when a message carries no real meaning for the sales chat. */
function isJunk(text, previousText) {
  const raw = String(text || "").trim();
  if (!raw) return false; // media / stickers are handled elsewhere, not counted as junk
  // Emoji / symbols / punctuation only (no letters or digits in any script).
  if (!/[\p{L}\p{N}]/u.test(raw)) return true;
  if (ABUSE_RE.test(raw)) return true;
  const t = normalize(raw);
  // Keyboard mash: one long "word" with no vowels, or the same char 5+ times.
  if (/^[a-z]{6,}$/.test(t) && !/[aeiouy]/.test(t)) return true;
  if (/(.)\1{4,}/.test(t.replace(/\s/g, "")) && t.replace(/[^a-z]/g, "").length <= 12) return true;
  if (/^(asdf|qwer|zxcv|jkl|hjkl|sdfg|dfgh)[a-z]*$/.test(t)) return true;
  // The same text as the previous customer message (a real question is not repeated word for word).
  if (previousText && t.length > 0 && t === normalize(previousText)) return true;
  return false;
}

/**
 * Was there a customer message after `messageId` in this chat?
 * Reactions don't count (they are not real replies).
 */
async function hasNewerInbound(conversationId, messageId) {
  if (!conversationId || !messageId) return false;
  try {
    return Boolean(
      await Message.exists({
        conversationId,
        direction: "inbound",
        type: { $ne: "reaction" },
        _id: { $gt: messageId },
      }),
    );
  } catch (err) {
    logger.warn("[reply-guard] newer-message check failed", { error: err.message });
    return false; // never block a reply because the check itself failed
  }
}

async function pauseForBot(conversation, lead, reason) {
  const res = await Conversation.updateOne(
    { _id: conversation._id, status: { $ne: "manual" } },
    {
      $set: {
        status: "manual",
        botGuardPausedAt: new Date(),
        botGuardReason: reason,
        aiSkipReason: `AI paused automatically: ${reason}. Check the chat and turn the AI back on if this is a real customer.`,
        aiSkipAt: new Date(),
      },
    },
  );
  conversation.status = "manual";
  if (!res.modifiedCount) return;
  logger.warn("[reply-guard] AI paused for chat (bot / flood)", { conversation: String(conversation._id), reason });
  try {
    const owner = conversation.ownerId;
    await Notification.create({
      userId: owner,
      type: "ai_bot_guard",
      title: "AI paused for a chat",
      body: `${lead?.name || lead?.phone || "A contact"}: ${reason}. The AI stopped replying so two bots don't talk in a loop.`,
      link: `/conversations?id=${conversation._id}`,
    });
    emitToUser(owner, "notification:new", { kind: "ai_bot_guard" });
    emitToUser(owner, "conversation:updated", { conversationId: conversation._id, status: "manual" });
  } catch (err) {
    logger.warn("[reply-guard] could not notify owner", { error: err.message });
  }
}

/**
 * Decide whether the AI may answer this customer message.
 * @returns {Promise<{ allow: boolean, reason?: string }>}
 */
async function checkInbound({ conversation, lead, message, text }) {
  if (!conversation || conversation.status !== "ai_active") return { allow: true };
  if (message?.type === "reaction") return { allow: true };
  try {
    const recent = await Message.find({
      conversationId: conversation._id,
      direction: "inbound",
      type: { $ne: "reaction" },
    })
      .sort({ _id: -1 })
      .limit(12)
      .select("text timestamp createdAt _id")
      .lean();

    // 1) Flood: more than FLOOD_MAX customer messages in the last minute.
    const since = Date.now() - FLOOD_WINDOW_MS;
    const lastMinute = recent.filter((m) => new Date(m.createdAt || m.timestamp).getTime() >= since).length;
    if (lastMinute > FLOOD_MAX) {
      await pauseForBot(conversation, lead, `${lastMinute} messages in one minute`);
      return { allow: false, reason: "flood" };
    }

    // 2) Same text over and over.
    const texts = recent.map((m) => normalize(m.text));
    // Only when we kept answering: a customer re-sending "hello?" because nobody
    // replied (e.g. during an outage) is not a bot.
    const repeated = texts.length >= REPEAT_PAUSE && texts[0] && texts.slice(0, REPEAT_PAUSE).every((t) => t === texts[0]);
    const answeredBetween = repeated
      ? await Message.countDocuments({ conversationId: conversation._id, direction: "outbound", _id: { $gt: recent[REPEAT_PAUSE - 1]._id } })
      : 0;
    if (repeated && answeredBetween >= REPEAT_PAUSE - 1) {
      await pauseForBot(conversation, lead, "the same message was sent again and again");
      return { allow: false, reason: "repeat" };
    }

    // 3) Reads like a chatbot / auto-reply.
    if (looksLikeBot(text)) {
      await pauseForBot(conversation, lead, "the replies look like another chatbot or an auto-reply");
      return { allow: false, reason: "bot" };
    }

    // 4) Junk streak.
    const previous = recent.find((m) => String(m._id) !== String(message?._id));
    const junk = isJunk(text, previous?.text);
    const streak = junk ? (conversation.junkStreak || 0) + 1 : 0;
    if (streak !== (conversation.junkStreak || 0)) {
      conversation.junkStreak = streak;
      await Conversation.updateOne({ _id: conversation._id }, { $set: { junkStreak: streak } }).catch(() => {});
    }
    if (junk && streak >= JUNK_LIMIT) {
      await Conversation.updateOne(
        { _id: conversation._id },
        { $set: { aiSkipReason: "AI is not replying to repeated junk messages. It replies again as soon as the customer sends a real message.", aiSkipAt: new Date() } },
      ).catch(() => {});
      logger.info("[reply-guard] junk streak — AI stays quiet", { conversation: String(conversation._id), streak });
      return { allow: false, reason: "junk" };
    }
  } catch (err) {
    logger.warn("[reply-guard] check failed — letting the AI reply", { error: err.message });
  }
  return { allow: true };
}

module.exports = { hasNewerInbound, checkInbound, looksLikeBot, isJunk };
