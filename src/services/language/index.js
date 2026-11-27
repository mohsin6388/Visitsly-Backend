/**
 * Conversation language (spec section E — highest priority).
 * See decide.js for the rules, localize.js for backend messages.
 */
module.exports = {
  ...require("./languages"),
  ...require("./detect"),
  ...require("./decide"),
  ...require("./localize"),
  ...require("./conversationLanguage"),
  ...require("./messages"),
};
