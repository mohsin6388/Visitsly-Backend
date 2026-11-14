const Conversation = require('../../models/Conversation');
const Message = require('../../models/Message');
const logger = require('../../utils/logger');

const STORE_AI_PROMPTS = String(process.env.AI_STORE_PROMPTS || 'false').toLowerCase() === 'true';

function emitLive(ownerId, conversationId, leadId, message, extra = {}) {
  if (!ownerId) return;
  try {
    // Lazy require: sockets/index.js is initialised after the models load.
    const { emitToUser } = require('../../sockets');
    emitToUser(ownerId, 'conversation:newMessage', {
      conversationId: String(conversationId),
      leadId: String(leadId),
      message: sanitize(message),
      preview: Message.previewOf(message),
      ...extra,
    });
  } catch (err) {
    logger.warn('[messages] live emit failed', { error: err.message });
  }
}

function sanitize(message) {
  const obj = message?.toObject ? message.toObject() : { ...(message || {}) };
  delete obj.aiPrompt;
  delete obj.aiResponseRaw;
  return obj;
}

/**
 * Persists an outbound message (AI, broker, campaign, follow-up, visit
 * confirmation …) after a successful Meta send, updates the inbox preview and
 * pushes it to every open dashboard in real time. This is the ONE place that
 * emits `conversation:newMessage` for outbound messages, so the AI inbox
 * shows AI replies live without a refresh.
 */
async function recordOutboundMessage({
  conversationId,
  leadId,
  text,
  sender = 'ai',
  whatsappMessageId,
  outboundJobId,
  aiPrompt,
  aiResponseRaw,
  intent,
  sentiment,
  type = 'text',
  media = null,
  ownerId = null,
}) {
  const message = await Message.create({
    conversationId,
    leadId,
    direction: 'outbound',
    sender: sender || 'ai',
    text: String(text || '').trim() || Message.previewOf({ type, media }) || '[message]',
    type,
    media,
    whatsappMessageId: whatsappMessageId || null,
    outboundJobId: outboundJobId || null,
    status: 'sent',
    aiPrompt: STORE_AI_PROMPTS ? aiPrompt || null : null,
    aiResponseRaw: STORE_AI_PROMPTS ? aiResponseRaw || null : null,
    intent: intent || null,
    sentiment: sentiment || null,
  });

  const conversation = await Conversation.findOneAndUpdate(
    { _id: conversationId },
    {
      $set: {
        lastMessageAt: message.timestamp,
        lastOutboundAt: message.timestamp,
        lastMessagePreview: Message.previewOf(message),
        lastMessageDirection: 'outbound',
        lastMessageSender: message.sender,
      },
    },
    { new: true, projection: { ownerId: 1, status: 1, unreadCount: 1 } },
  ).lean();

  emitLive(ownerId || conversation?.ownerId, conversationId, leadId, message, {
    conversation: conversation ? { _id: conversation._id, status: conversation.status, unreadCount: conversation.unreadCount } : undefined,
  });
  return message;
}

/** Updates the inbox preview for an inbound message and emits it live. */
async function afterInbound(conversation, message) {
  await Conversation.updateOne(
    { _id: conversation._id },
    {
      $set: {
        lastMessagePreview: Message.previewOf(message),
        lastMessageDirection: 'inbound',
        lastMessageSender: 'customer',
      },
    },
  );
  emitLive(conversation.ownerId, conversation._id, message.leadId, message, {
    conversation: { _id: conversation._id, status: conversation.status, unreadCount: conversation.unreadCount },
  });
}

module.exports = { recordOutboundMessage, afterInbound, sanitize };
