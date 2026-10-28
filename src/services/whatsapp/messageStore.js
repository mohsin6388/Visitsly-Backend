const Conversation = require('../../models/Conversation');
const Message = require('../../models/Message');

/** Persists an outbound message record — called after a successful Meta WhatsApp Cloud API send. */
async function recordOutboundMessage({ conversationId, leadId, text, sender, whatsappMessageId, outboundJobId, aiPrompt, aiResponseRaw, intent, sentiment }) {
  const message = await Message.create({
    conversationId,
    leadId,
    direction: 'outbound',
    sender,
    text,
    whatsappMessageId: whatsappMessageId || null,
    outboundJobId: outboundJobId || null,
    status: 'sent',
    aiPrompt: aiPrompt || null,
    aiResponseRaw: aiResponseRaw || null,
    intent: intent || null,
    sentiment: sentiment || null,
  });
  await Conversation.updateOne({ _id: conversationId }, { $set: { lastMessageAt: message.timestamp } });
  return message;
}

module.exports = { recordOutboundMessage };
