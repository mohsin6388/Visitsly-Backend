/**
 * Reads and saves a conversation's language (E2, E5).
 *
 * Conversation fields
 *   language                canonical name ("Hindi", "Hinglish", "Tamil"…)
 *   languageSource          'selected' (customer chose / asked) | 'detected' | 'agent'
 *   languageLockedAt        when it was last set
 *   languagePromptedAt      when the one-time language question was sent (never again)
 *   languagePromptAnsweredAt  when the customer answered it
 */
const Conversation = require("../../models/Conversation");
const languages = require("./languages");
const logger = require("../../utils/logger");

/** Persists a decision from decide.js (only what changed). Updates `conversation` in place. */
async function applyDecision(conversation, decision) {
  if (!conversation?._id || !decision) return false;
  const set = {};
  if (decision.changed && decision.language) {
    set.language = decision.language;
    set.languageSource = decision.source;
    set.languageLockedAt = new Date();
  }
  if (decision.promptAnswered && !conversation.languagePromptAnsweredAt) {
    set.languagePromptAnsweredAt = new Date();
  }
  if (!Object.keys(set).length) return false;
  Object.assign(conversation, set);
  // Keep the copy the AI reads (collectedRequirements.language) in step.
  if (set.language && conversation.collectedRequirements && typeof conversation.collectedRequirements === "object") {
    conversation.collectedRequirements.language = set.language;
  }
  try {
    await Conversation.updateOne({ _id: conversation._id }, { $set: set });
    if (set.language) {
      try {
        // Inbox side panel shows the saved language live.
        require("../../sockets").emitToUser(conversation.ownerId, "conversation:updated", {
          conversationId: conversation._id,
          language: set.language,
          languageSource: set.languageSource,
        });
      } catch { /* sockets not initialised (scripts / tests) */ }
      logger.info("[language] conversation language saved", {
        conversation: String(conversation._id),
        language: set.language,
        source: set.languageSource,
        reason: decision.reason,
      });
    }
  } catch (err) {
    logger.warn("[language] could not save the conversation language", { error: err.message });
  }
  return true;
}

/**
 * Claims the one-time language question for this chat. Only the first caller
 * gets true — two quick messages never get the question twice.
 */
async function claimLanguagePrompt(conversationId) {
  try {
    const res = await Conversation.updateOne(
      { _id: conversationId, languagePromptedAt: null, language: { $in: [null, "English"] } },
      { $set: { languagePromptedAt: new Date() } },
    );
    return Boolean(res.modifiedCount);
  } catch (err) {
    logger.warn("[language] could not claim the language question", { error: err.message });
    return false;
  }
}

/** Team sets / clears the language in the inbox. null → back to automatic. */
async function setByAgent(conversation, language) {
  const name = language ? languages.normalize(language) : null;
  if (language && !name) throw new Error("Unsupported language");
  const set = name
    ? { language: name, languageSource: languages.SOURCES.AGENT, languageLockedAt: new Date() }
    : { language: null, languageSource: null, languageLockedAt: null };
  await Conversation.updateOne({ _id: conversation._id }, { $set: set });
  Object.assign(conversation, set);
  return name;
}

/** Saved language for a lead's chat (null when none). */
async function savedLanguageForLead(leadId) {
  if (!leadId) return null;
  try {
    const c = await Conversation.findOne({ leadId }).select("language").lean();
    return languages.normalize(c?.language) || null;
  } catch {
    return null;
  }
}

module.exports = { applyDecision, claimLanguagePrompt, setByAgent, savedLanguageForLead };
