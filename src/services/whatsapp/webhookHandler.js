const Lead = require("../../models/Lead");
const Conversation = require("../../models/Conversation");
const Message = require("../../models/Message");
const User = require("../../models/User");
const Notification = require("../../models/Notification");
const logger = require("../../utils/logger");
const { emitToUser } = require("../../sockets");
const conversationEngine = require("../ai/conversationEngine");
const env = require("../../config/env");
const tenantContext = require("../../context/tenantContext");
const orgService = require("../saas/orgService");

/**
 * Real Meta WhatsApp Cloud API "messages" webhook body:
 * {
 *   "object": "whatsapp_business_account",
 *   "entry": [{
 *     "id": "<WABA_ID>",
 *     "changes": [{
 *       "field": "messages",
 *       "value": {
 *         "messaging_product": "whatsapp",
 *         "metadata": { "display_phone_number": "...", "phone_number_id": "..." },
 *         "contacts": [{ "profile": { "name": "Ramesh" }, "wa_id": "919876543210" }],
 *         "messages": [{
 *           "from": "919876543210",
 *           "id": "wamid.HBg...",
 *           "timestamp": "1731500000",
 *           "type": "text",
 *           "text": { "body": "Hello" }
 *         }],
 *         // Delivery/read receipts arrive as `statuses`, not `messages` —
 *         // same webhook field, different shape; must be ignored here.
 *         "statuses": [{ "id": "wamid...", "status": "delivered", ... }]
 *       }
 *     }]
 *   }]
 * }
 */

/**
 * Canonical phone format we WRITE to the DB going forward: bare digits with
 * country code, no "+", no spaces/dashes. Meta's `from` / `wa_id` fields are
 * already in this exact shape, so this is mostly a safety net.
 */
function normalizePhone(rawPhone) {
  if (!rawPhone) return null;
  const digits = String(rawPhone).replace(/[^\d]/g, "");
  return digits || null;
}

/**
 * Leads can have their phone saved in different formats depending on how
 * they came in ("+919876543210", "919876543210", or even just "9876543210"
 * without a country code) — but the incoming webhook always gives us bare
 * digits with country code (e.g. "919876543210"). Try the exact digit and
 * "+digit" forms first, then fall back to a last-10-digit suffix match so a
 * lead saved without a country code still resolves correctly.
 */
async function findLeadByPhone(digits) {
  if (!digits) return null;

  // SaaS: the same buyer can be a lead of two different companies — only
  // ever match inside the company whose WhatsApp number received this.
  const ownerId = tenantContext.ownerId();
  const scope = ownerId ? { ownerId } : {};

  let lead = await Lead.findOne({ ...scope, phone: { $in: [digits, `+${digits}`] } });
  if (lead) return lead;

  const last10 = digits.slice(-10);
  if (last10.length === 10) {
    lead = await Lead.findOne({ ...scope, phone: new RegExp(`${last10}$`) });
  }
  return lead;
}

/**
 * Resolves which broker/user a brand-new inbound lead (one who messaged us
 * first, before ever being added/imported) should belong to. Since this
 * deployment has exactly ONE connected WhatsApp number (META_WHATSAPP_PHONE_
 * NUMBER_ID is global, not per-org), there's no per-message signal telling
 * us which broker's number this is — so we rely on DEFAULT_LEAD_OWNER_ID,
 * falling back to the first admin/broker account if that's not configured.
 *
 * Cached in-process for a few minutes so every inbound message from an
 * unknown number doesn't re-hit the Users collection.
 */
let cachedOwner = null;
let cachedOwnerAt = 0;
const OWNER_CACHE_MS = 5 * 60 * 1000;

async function resolveDefaultOwner() {
  const tenantOwnerId = tenantContext.ownerId();
  if (tenantOwnerId) return User.findById(tenantOwnerId);
  if (cachedOwner && Date.now() - cachedOwnerAt < OWNER_CACHE_MS)
    return cachedOwner;

  let owner = null;
  if (env.leads.defaultOwnerId) {
    owner = await User.findById(env.leads.defaultOwnerId);
    if (!owner) {
      logger.warn(
        `[whatsapp] DEFAULT_LEAD_OWNER_ID=${env.leads.defaultOwnerId} does not match any User — falling back`,
      );
    }
  }

  if (!owner) {
    owner = await User.findOne({
      role: { $in: ["broker", "builder", "admin"] },
      isActive: true,
    }).sort({ createdAt: 1 });
  }

  if (owner) {
    cachedOwner = owner;
    cachedOwnerAt = Date.now();
  }
  return owner;
}

/**
 * Creates a Conversation for a lead, safely handling the case where a
 * concurrent webhook delivery (retry, or two near-simultaneous messages)
 * already created one in a race — `leadId` is unique on Conversation, so
 * the loser of the race re-fetches instead of throwing.
 */
async function findOrCreateConversation(lead) {
  let conversation = await Conversation.findOne({ leadId: lead._id });
  if (conversation) return conversation;

  try {
    conversation = await Conversation.create({
      leadId: lead._id,
      ownerId: lead.ownerId,
    });
  } catch (err) {
    if (err.code === 11000) {
      conversation = await Conversation.findOne({ leadId: lead._id });
    } else {
      throw err;
    }
  }
  return conversation;
}

/**
 * Someone messaged the connected WhatsApp number who isn't in the CRM yet
 * (no lead has this phone). Auto-creates a Lead + Conversation for them so
 * the AI engine can pick the message up exactly like it would for any
 * existing lead — this is what makes "new number messages us -> AI responds
 * too" work, not just "we message a number first".
 */
async function createLeadForUnknownSender(phone, contactName) {
  const owner = await resolveDefaultOwner();
  if (!owner) {
    logger.warn(
      `[whatsapp] Inbound message from unrecognized number ${phone} — no default lead owner configured (set DEFAULT_LEAD_OWNER_ID or create a broker/admin user), ignoring`,
    );
    return null;
  }

  // Phone can't collide with an existing lead here (findLeadByPhone already
  // returned nothing), but two webhook retries racing each other could both
  // reach this point — the unique (ownerId, phone) index is the real guard;
  // fall back to re-fetching if we lose that race.
  let lead;
  try {
    lead = await Lead.create({
      ownerId: owner._id,
      name: contactName || `WhatsApp ${phone}`,
      phone,
      source: "whatsapp_inbound",
    });
  } catch (err) {
    if (err.code === 11000) {
      lead = await Lead.findOne({ ownerId: owner._id, phone });
    } else {
      throw err;
    }
  }
  if (!lead) return null;

  const conversation = await findOrCreateConversation(lead);

  // SaaS lead routing (round-robin) for buyers who message first.
  const routedOrg = tenantContext.getOrg();
  if (routedOrg) {
    await require("../leads/routing").autoAssign(routedOrg, lead).catch(() => null);
  }

  logger.info(
    `[whatsapp] Auto-created new lead ${lead._id} for unrecognized inbound number ${phone}`,
  );

  await Notification.create({
    userId: owner._id,
    type: "new_lead",
    title: `New WhatsApp message from ${phone}`,
    body: "This number messaged you first and was added as a new lead automatically.",
    link: `/whatsapp/conversations?lead=${lead._id}`,
  });
  emitToUser(owner._id, "notification:new", { leadId: lead._id });
  emitToUser(owner._id, "lead:new", { lead });

  return { lead, conversation };
}

/**
 * Turns any Meta inbound message (text, button, list, image, video, audio,
 * document, sticker, location, contacts, reaction) into
 * { type, text, media } where `text` is always a readable line for the inbox
 * and for the AI, and `media` keeps Meta's media id + file details.
 */
function parseInbound(msg) {
  const type = msg.type || 'unknown';
  switch (type) {
    case 'text':
      return { type: 'text', text: msg.text?.body?.trim() || '', media: null, aiText: msg.text?.body?.trim() || '' };
    case 'button':
      return { type: 'interactive', text: msg.button?.text?.trim() || '', media: null, aiText: msg.button?.text?.trim() || '' };
    case 'interactive': {
      const t = msg.interactive?.button_reply?.title?.trim() || msg.interactive?.list_reply?.title?.trim() || '';
      return { type: 'interactive', text: t, media: null, aiText: t };
    }
    case 'image':
    case 'video':
    case 'audio':
    case 'document':
    case 'sticker': {
      const m = msg[type] || {};
      const caption = m.caption?.trim() || '';
      const label = { image: '[Photo]', video: '[Video]', audio: '[Voice note]', document: `[Document${m.filename ? `: ${m.filename}` : ''}]`, sticker: '[Sticker]' }[type];
      return {
        type,
        text: caption ? `${label} ${caption}` : label,
        media: {
          id: m.id || null,
          mimeType: m.mime_type || null,
          filename: m.filename || null,
          caption: caption || null,
          sha256: m.sha256 || null,
        },
        // The AI only sees a description; it should acknowledge the file and,
        // for documents/photos, say the team will review it.
        aiText: caption
          ? `(Customer ne ${type === 'image' ? 'ek photo' : type === 'document' ? 'ek document' : type === 'video' ? 'ek video' : 'ek file'} bheja, caption: "${caption}")`
          : `(Customer ne ${type === 'image' ? 'ek photo' : type === 'document' ? `ek document${m.filename ? ` "${m.filename}"` : ''}` : type === 'video' ? 'ek video' : type === 'audio' ? 'ek voice note' : 'ek sticker'} bheja)`,
      };
    }
    case 'location': {
      const l = msg.location || {};
      const where = [l.name, l.address].filter(Boolean).join(', ');
      return {
        type: 'location',
        text: `[Location] ${where || `${l.latitude}, ${l.longitude}`}`,
        media: { latitude: l.latitude ?? null, longitude: l.longitude ?? null, address: where || null },
        aiText: `(Customer ne apni location bheji: ${where || `${l.latitude}, ${l.longitude}`})`,
      };
    }
    case 'contacts': {
      const c = (msg.contacts || [])[0] || {};
      const name = c.name?.formatted_name || 'Contact';
      const phone = c.phones?.[0]?.phone || '';
      return { type: 'contacts', text: `[Contact] ${name} ${phone}`.trim(), media: null, aiText: `(Customer ne ek contact share kiya: ${name} ${phone})` };
    }
    case 'reaction':
      return { type: 'reaction', text: `[Reaction] ${msg.reaction?.emoji || ''}`.trim(), media: null, aiText: '', skipAi: true };
    default:
      return { type: 'unknown', text: `[${type} message]`, media: null, aiText: '', skipAi: true };
  }
}

// Hard opt-out (Meta policy: must stop messaging) vs soft "not interested"
// (we politely follow up again later — see followUpAutomation.js).
const OPT_OUT_RE = /^\s*(stop|unsubscribe|block|band karo|band kro|message mat (karo|bhejo|kro)|mat bhejo|don'?t (message|msg|text)|remove me|do not (contact|message))\b/i;
const DECLINE_RE = /\b(not interested|no interest|interest nahi|nahi chahiye|nhi chahiye|nahin chahiye|no thanks|no thank you|abhi nahi|abhi nhi|zarurat nahi|zaroorat nahi|need nahi|not now|not looking)\b/i;

/**
 * Handles one inbound message object from a Meta webhook delivery.
 * Always resolves/returns quickly and never throws — Meta retries on any
 * non-200 response, and a thrown error here would otherwise turn one bad
 * payload into repeated retried duplicate deliveries.
 */
async function handleInboundMessage(waMessage, contact) {
  const parsed = parseInbound(waMessage);
  const rawText = parsed.aiText;
  const text = parsed.text || `[${waMessage.type || 'message'}]`;

  const phone = normalizePhone(waMessage.from);
  if (!phone) {
    logger.warn(
      "[whatsapp] Webhook message had no resolvable sender phone number, ignoring",
      { messageId: waMessage.id },
    );
    return;
  }

  let lead = await findLeadByPhone(phone);
  let conversation;

  if (!lead) {
    // Brand-new number we've never seen before — auto-create the lead
    // (and its conversation) so the AI can respond to them too, instead
    // of only ever replying to numbers that were imported/added first.
    const created = await createLeadForUnknownSender(
      phone,
      contact?.profile?.name,
    );
    if (!created) return; // no default owner configured — see createLeadForUnknownSender for how to fix
    ({ lead, conversation } = created);
  } else {
    conversation = await findOrCreateConversation(lead);
  }

  // Multi-number companies: remember which of their numbers this buyer uses,
  // so manual replies and follow-ups go out from the same number.
  const viaNumber = tenantContext.numberOverride();
  if (viaNumber && conversation && conversation.phoneNumberId !== viaNumber) {
    await Conversation.updateOne({ _id: conversation._id }, { $set: { phoneNumberId: viaNumber } });
    conversation.phoneNumberId = viaNumber;
  }

  const whatsappMessageId = waMessage.id;
  if (whatsappMessageId) {
    const alreadyExists = await Message.findOne({ whatsappMessageId }).lean();
    if (alreadyExists) return; // dedup — webhook retry protection
  }

  const timestampSec = Number(waMessage.timestamp);
  const timestamp = Number.isFinite(timestampSec)
    ? new Date(timestampSec * 1000)
    : new Date();

  let savedMessage;
  try {
    savedMessage = await Message.create({
      conversationId: conversation._id,
      leadId: lead._id,
      direction: "inbound",
      sender: "customer",
      text,
      type: parsed.type,
      media: parsed.media,
      whatsappMessageId: whatsappMessageId || null,
      timestamp,
    });
  } catch (err) {
    if (err.code === 11000) return; // concurrent webhook retry already stored it
    throw err;
  }

  // Reactions are not real replies — store them, but don't bump unread/AI.
  if (parsed.type !== "reaction") {
    conversation.lastMessageAt = savedMessage.timestamp;
    conversation.lastInboundAt = savedMessage.timestamp;
    conversation.unreadCount += 1;
  }
  // Once the lead has messaged us for real, the opening template's job is
  // done — every reply from here on is free-text within the 24h window.
  conversation.templateSent = true;

  // Opt-out / decline handling (see followUpAutomation.js for re-follow-ups).
  const body = String(parsed.type === "text" || parsed.type === "interactive" ? parsed.text : "");
  if (body && OPT_OUT_RE.test(body)) {
    conversation.optedOut = true;
    conversation.optedOutAt = new Date();
    conversation.status = "paused";
    await Lead.updateOne({ _id: lead._id }, { $set: { optedOut: true } }).catch(() => {});
  } else if (body && DECLINE_RE.test(body)) {
    conversation.declinedAt = new Date();
    conversation.declineCount = (conversation.declineCount || 0) + 1;
  } else if (conversation.optedOut && body && /^\s*(start|hi|hello|hey|namaste)\b/i.test(body)) {
    // Customer came back on their own — they may be messaged again.
    conversation.optedOut = false;
    conversation.optedOutAt = null;
    if (conversation.status === "paused") conversation.status = "ai_active";
    await Lead.updateOne({ _id: lead._id }, { $set: { optedOut: false } }).catch(() => {});
  }
  await conversation.save();

  await require("./messageStore").afterInbound(conversation, savedMessage);

  // Copy photos / PDFs / videos to permanent storage in the background.
  if (savedMessage.media?.id) {
    const mediaService = require("./mediaService");
    setImmediate(() => mediaService.persistInboundMedia(savedMessage._id).catch(() => {}));
  }

  // Blue ticks + typing indicator (one call does both). Never blocks the AI.
  if (parsed.type !== "reaction") {
    require("./metaWhatsappClient")
      .sendTypingIndicator(whatsappMessageId)
      .catch(() => {});
  }

  if (parsed.skipAi) return;

  // Customer asked us to stop — acknowledge once, then stay silent.
  if (conversation.optedOut) {
    try {
      const ack = "Theek hai, ab aapko hum message nahi karenge. Kabhi bhi zarurat ho to yahan \"Hi\" likh dijiye 🙏";
      const { messageId } = await require("./metaWhatsappClient").sendTextMessage({ phone: lead.phone, text: ack });
      await require("./messageStore").recordOutboundMessage({ conversationId: conversation._id, leadId: lead._id, text: ack, sender: "ai", whatsappMessageId: messageId, ownerId: conversation.ownerId });
    } catch (err) {
      logger.warn("[whatsapp] Opt-out acknowledgement failed", { error: err.message });
    }
    return;
  }

  // Site visit confirmation: "YES" / "NO" jaise chhote jawab ka seedha jawab
  // yahin de dete hain, AI ko bhejne ki zaroorat nahi.
  try {
    const handled = await require("../visits/visitConfirmation").handleReply({
      lead,
      conversation,
      text: rawText,
    });
    if (handled) return;
  } catch (confirmErr) {
    logger.warn("[visit-confirm] Reply check failed", { error: confirmErr.message });
  }

  // Hand off to the AI engine. Awaited so replies for a given lead stay in
  // order, but wrapped in its own try/catch — an AI failure must never
  // surface back as a webhook failure (which would trigger Meta retries).
  try {
    await conversationEngine.handleInbound({
      conversation,
      lead,
      message: { ...savedMessage.toObject(), text: rawText || savedMessage.text },
    });
  } catch (aiErr) {
    logger.error(`[ai] Conversation engine failed for lead ${lead._id}`, {
      error: aiErr.message,
    });
  }
}

/**
 * Entry point called by the webhook controller for every POST delivery.
 * A single delivery can contain multiple entries/changes/messages batched
 * together, so everything here is looped, and each message is processed
 * one at a time (kept sequential — simpler ordering guarantees, and volume
 * per delivery is tiny in practice).
 */
async function handleWebhook(payload) {
  try {
    if (!payload || payload.object !== "whatsapp_business_account") return;

    const entries = Array.isArray(payload.entry) ? payload.entry : [];
    for (const entry of entries) {
      const changes = Array.isArray(entry.changes) ? entry.changes : [];
      for (const change of changes) {
        if (change.field !== "messages") continue; // ignore non-message webhook fields
        const value = change.value || {};

        // SaaS: one Meta app webhook serves every company. Route each change
        // to the company that owns the receiving phone number.
        if (env.saas.enabled) {
          const phoneNumberId = value.metadata?.phone_number_id;
          const org = await orgService.getSnapshotForPhoneNumberId(phoneNumberId);
          if (!org) {
            logger.warn(`[whatsapp] Webhook for unknown phone_number_id=${phoneNumberId} — no company has this number, ignoring`);
            continue;
          }
          await tenantContext.run(org, () => tenantContext.runWithNumber(phoneNumberId, () => processChange(value)));
          continue;
        }
        await processChange(value);
      }
    }
  } catch (err) {
    logger.error("[whatsapp] Failed to process webhook payload", {
      error: err.message,
    });
  }
}

async function processChange(value) {
  {
    {
      {

        // Status callbacks (sent/delivered/read/failed for OUR outbound
        // messages) land here too, under `statuses` instead of `messages` —
        // nothing to do with them yet, just don't treat them as inbound text.
        if (Array.isArray(value.statuses) && value.statuses.length) {
          for (const s of value.statuses) {
            const mappedStatus = [
              "sent",
              "delivered",
              "read",
              "failed",
            ].includes(s.status)
              ? s.status
              : null;
            if (mappedStatus && s.id) {
              const firstError = Array.isArray(s.errors) ? s.errors[0] : null;
              await Message.updateOne(
                { whatsappMessageId: s.id },
                {
                  $set: {
                    status: mappedStatus,
                    errorCode: firstError?.code
                      ? String(firstError.code)
                      : null,
                    errorMessage:
                      firstError?.title || firstError?.message || null,
                  },
                },
              );
            }
            if (s.status === "failed") {
              logger.warn("[whatsapp] Outbound message delivery failed", {
                messageId: s.id,
                errors: s.errors,
              });
            }
          }
        }

        const messages = Array.isArray(value.messages) ? value.messages : [];
        if (!messages.length) return;

        const contactsByWaId = new Map(
          (value.contacts || []).map((c) => [c.wa_id, c]),
        );

        for (const waMessage of messages) {
          logger.info(
            `[whatsapp] Webhook message received: type=${waMessage.type} from=${waMessage.from} id=${waMessage.id}`,
          );
          await handleInboundMessage(
            waMessage,
            contactsByWaId.get(waMessage.from),
          );
        }
      }
    }
  }
}

module.exports = { handleWebhook, normalizePhone, findLeadByPhone };
