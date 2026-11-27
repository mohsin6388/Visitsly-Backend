const Lead = require('../../models/Lead');
const Conversation = require('../../models/Conversation');
const Message = require('../../models/Message');
const Organization = require('../../models/Organization');
const Notification = require('../../models/Notification');
const logger = require('../../utils/logger');
const tenantContext = require('../../context/tenantContext');
const orgService = require('../saas/orgService');

/**
 * WhatsApp Coexistence webhooks (number runs in the WhatsApp Business app AND
 * on Cloud API):
 *
 *  - smb_message_echoes : staff replied from the phone app  -> saved as "broker"
 *                         message. The AI is NOT triggered by an echo.
 *  - history            : old chats (day 0-1, 1-90, 90-180) -> imported into threads
 *  - smb_app_state_sync : contacts added/edited/removed in the app -> upsert leads
 *  - account_update     : PARTNER_REMOVED = client disconnected from the phone
 *
 * Payload parsing is deliberately defensive (Meta omits fields freely, and
 * customers may be identified by user_id instead of a phone number).
 */

/** Which number this webhook is for (main or one extra), from the phone_number_id the webhook was routed by. */
function currentNumber() {
  const org = tenantContext.getOrg();
  if (!org) return null;
  const t = require('../saas/whatsappConnect').numberTarget(org, tenantContext.numberOverride());
  return t ? { ...t, orgId: org._id } : { extra: false, id: org.whatsapp?.phoneNumberId || null, prefix: 'whatsapp', opts: {}, record: org.whatsapp || {}, orgId: org._id };
}
/** $set on the current number's `coexistence.*` state (main: whatsapp.coexistence.*, extra: extraNumbers.$[n].coexistence.*). */
async function setCoex(fields) {
  const t = currentNumber();
  if (!t?.orgId) return;
  const $set = {};
  for (const [k, val] of Object.entries(fields)) $set[`${t.prefix}.coexistence.${k}`] = val;
  await Organization.updateOne({ _id: t.orgId }, { $set }, t.opts);
  orgService.invalidate(t.orgId);
}

const digits = (v) => String(v || '').replace(/\D/g, '') || null;

function toDate(sec) {
  const n = Number(sec);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : new Date();
}

/** Same readable text / type mapping the inbox uses for media etc. */
function describe(msg) {
  const type = msg?.type || 'text';
  if (type === 'text') return { type: 'text', text: msg.text?.body?.trim() || '', media: null };
  const labels = { image: '[Photo]', video: '[Video]', audio: '[Voice note]', document: '[Document]', sticker: '[Sticker]', location: '[Location]', contacts: '[Contact]', reaction: '[Reaction]' };
  const m = msg[type] || {};
  const caption = m.caption?.trim() || '';
  const label = labels[type] || `[${type} message]`;
  const known = ['image', 'video', 'audio', 'document', 'sticker', 'location', 'contacts', 'reaction', 'interactive'];
  return {
    type: known.includes(type) ? type : 'unknown',
    text: caption ? `${label} ${caption}` : label,
    media: ['image', 'video', 'audio', 'document', 'sticker'].includes(type)
      ? { id: m.id || null, mimeType: m.mime_type || null, filename: m.filename || null, caption: caption || null, sha256: m.sha256 || null }
      : null,
  };
}

async function findLead(phone) {
  const { findLeadByPhone } = require('./webhookHandler');
  return findLeadByPhone(phone);
}

/** Lead + conversation for a customer who is only known from phone-app activity. Silent (no notification). */
async function ensureThread(phone, name, { imported = false } = {}) {
  let lead = await findLead(phone);
  if (!lead) {
    const ownerId = tenantContext.ownerId();
    if (!ownerId) return null;
    try {
      lead = await Lead.create({ ownerId, name: name || `WhatsApp ${phone}`, phone, source: 'whatsapp_inbound' });
    } catch (err) {
      if (err.code === 11000) lead = await Lead.findOne({ ownerId, phone });
      else throw err;
    }
    if (!lead) return null;
  }
  let conversation = await Conversation.findOne({ leadId: lead._id });
  if (!conversation) {
    try {
      conversation = await Conversation.create({
        leadId: lead._id,
        ownerId: lead.ownerId,
        // Remember which of the company's numbers this chat belongs to.
        ...(tenantContext.numberOverride() ? { phoneNumberId: tenantContext.numberOverride() } : {}),
        // Old chats must not get AI replies or automatic follow-ups until the customer writes again.
        ...(imported ? { status: 'paused', coexistenceImported: true } : {}),
      });
    } catch (err) {
      if (err.code === 11000) conversation = await Conversation.findOne({ leadId: lead._id });
      else throw err;
    }
  }
  return conversation ? { lead, conversation } : null;
}

/* ---------------- smb_message_echoes ---------------- */

async function handleEchoes(value) {
  const echoes = Array.isArray(value.message_echoes) ? value.message_echoes : [];
  for (const echo of echoes) {
    try {
      const phone = digits(echo.to);
      if (!phone || !echo.id) continue; // BSUID-only customers cannot be matched to a lead yet
      if (await Message.exists({ whatsappMessageId: echo.id })) continue;
      const thread = await ensureThread(phone, null);
      if (!thread) continue;
      const parsed = describe(echo);
      const { recordOutboundMessage } = require('./messageStore');
      const saved = await recordOutboundMessage({
        conversationId: thread.conversation._id,
        leadId: thread.lead._id,
        text: parsed.text,
        sender: 'broker',
        whatsappMessageId: echo.id,
        type: parsed.type,
        media: parsed.media,
        ownerId: thread.conversation.ownerId,
      });
      await Message.updateOne({ _id: saved._id }, { $set: { source: 'phone_app', timestamp: toDate(echo.timestamp) } });
      await setCoex({ lastEchoAt: new Date() });
    } catch (err) {
      if (err.code !== 11000) logger.warn('[whatsapp] Could not store phone-app reply (echo)', { error: err.message, messageId: echo?.id });
    }
  }
}

/* ---------------- history ---------------- */

async function bumpProgress(progress) {
  const n = Math.max(0, Math.min(100, Number(progress)));
  if (!Number.isFinite(n)) return;
  const fields = { historySyncProgress: n };
  if (n >= 100) fields.historySyncStatus = 'done';
  await setCoex(fields);
}

async function handleHistory(value) {
  const chunks = Array.isArray(value.history) ? value.history : [];
  for (const chunk of chunks) {
    // Error 2593109 = the client refused to share chat history in the phone app.
    const refused = (chunk.errors || []).some((e) => String(e?.code) === '2593109');
    if (refused) {
      await setCoex({ historySyncStatus: 'declined', historySyncProgress: 100 });
      continue;
    }
    if ((chunk.errors || []).length) {
      logger.warn('[whatsapp] History sync chunk returned errors', { errors: chunk.errors });
      continue;
    }
    const threads = Array.isArray(chunk.threads) ? chunk.threads : [];
    for (const thread of threads) {
      try {
        await importThread(thread);
      } catch (err) {
        logger.warn('[whatsapp] History thread import failed', { error: err.message });
      }
    }
    await bumpProgress(chunk.metadata?.progress);
  }
}

async function importThread(thread) {
  const phone = digits(thread.id);
  if (!phone) return; // customer identified only by BSUID
  const messages = (Array.isArray(thread.messages) ? thread.messages : [])
    .filter((m) => m?.id)
    .sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  if (!messages.length) return;
  const known = new Set((await Message.find({ whatsappMessageId: { $in: messages.map((m) => m.id) } }).select('whatsappMessageId').lean()).map((m) => m.whatsappMessageId));
  const fresh = messages.filter((m) => !known.has(m.id));
  if (!fresh.length) return;

  const t = await ensureThread(phone, null, { imported: true });
  if (!t) return;
  const business = digits(currentNumber()?.record?.displayPhoneNumber);

  const docs = fresh.map((m) => {
    const parsed = describe(m);
    const fromBusiness = business ? digits(m.from) === business : digits(m.from) !== phone;
    return {
      conversationId: t.conversation._id,
      leadId: t.lead._id,
      direction: fromBusiness ? 'outbound' : 'inbound',
      sender: fromBusiness ? 'broker' : 'customer',
      text: parsed.text || `[${m.type || 'message'}]`,
      type: parsed.type,
      media: parsed.media,
      whatsappMessageId: m.id,
      status: ['sent', 'delivered', 'read'].includes(String(m.history_context?.status || '').toLowerCase()) ? String(m.history_context.status).toLowerCase() : 'sent',
      source: 'history',
      timestamp: toDate(m.timestamp),
    };
  });
  try {
    await Message.insertMany(docs, { ordered: false });
  } catch (err) {
    // Duplicate whatsappMessageId (webhook retry) -> the rest were still inserted.
    if (!(err.code === 11000 || err.writeErrors)) throw err;
  }
  const last = docs[docs.length - 1];
  const lastInbound = [...docs].reverse().find((d) => d.direction === 'inbound');
  const update = {};
  if (!t.conversation.lastMessageAt || last.timestamp > t.conversation.lastMessageAt) {
    Object.assign(update, { lastMessageAt: last.timestamp, lastMessagePreview: Message.previewOf(last), lastMessageDirection: last.direction, lastMessageSender: last.sender });
  }
  if (lastInbound && (!t.conversation.lastInboundAt || lastInbound.timestamp > t.conversation.lastInboundAt)) update.lastInboundAt = lastInbound.timestamp;
  if (Object.keys(update).length) await Conversation.updateOne({ _id: t.conversation._id }, { $set: update });
}

/* ---------------- smb_app_state_sync (contacts) ---------------- */

async function handleStateSync(value) {
  const items = Array.isArray(value.state_sync) ? value.state_sync : [];
  const ownerId = tenantContext.ownerId();
  if (!ownerId) return;
  for (const item of items) {
    try {
      if (item.type !== 'contact') continue;
      const phone = digits(item.contact?.phone_number);
      if (!phone) continue;
      const name = item.contact?.full_name || item.contact?.first_name || null;
      if (item.action === 'remove') continue; // never delete CRM leads because a phone contact was removed
      const existing = await findLead(phone);
      if (existing) {
        if (name && (!existing.name || existing.name.startsWith('WhatsApp '))) await Lead.updateOne({ _id: existing._id }, { $set: { name } });
        continue;
      }
      try {
        await Lead.create({ ownerId, name: name || `WhatsApp ${phone}`, phone, source: 'whatsapp_contact' });
      } catch (err) {
        if (err.code !== 11000) throw err;
      }
    } catch (err) {
      logger.warn('[whatsapp] Contact sync item failed', { error: err.message });
    }
  }
  await setCoex({ contactsSyncStatus: 'done' });
}

/* ---------------- account_update ---------------- */

async function handleAccountUpdate(entryWabaId, value) {
  const event = String(value?.event || '').toUpperCase();
  if (event !== 'PARTNER_REMOVED') return;
  const wabaId = String(value?.waba_info?.waba_id || entryWabaId || '');
  if (!wabaId) return;
  const orgs = await Organization.find({ 'whatsapp.businessAccountId': wabaId }).select('_id ownerUserId').lean();
  for (const org of orgs) {
    await Organization.updateOne({ _id: org._id }, {
      $set: {
        'whatsapp.status': 'not_connected',
        'whatsapp.accessTokenEncrypted': null, // stops the bot / any further sends
        'whatsapp.isCoexistence': false,
        'whatsapp.coexistence.disconnectedFromPhoneAt': new Date(),
        'whatsapp.lastError': 'The WhatsApp number was removed from Visitsly (via the phone’s Business Platform setting). Please reconnect.',
        'whatsapp.lastErrorCode': 'PARTNER_REMOVED',
        'whatsapp.lastErrorStage': 'account_update',
        'whatsapp.lastErrorAt': new Date(),
        'onboarding.whatsappDone': false,
      },
    });
    orgService.invalidate(org._id);
    if (org.ownerUserId) {
      await Notification.create({ userId: org.ownerUserId, type: 'whatsapp_connection', title: 'WhatsApp disconnected', body: 'The number was removed from Visitsly on the phone. AI replies are paused. Please reconnect.', link: '/whatsapp' }).catch(() => {});
    }
    logger.info('[whatsapp] PARTNER_REMOVED — WhatsApp marked disconnected', { orgId: String(org._id), wabaId });
  }
  // Extra numbers onboarded through coexistence on this WABA: same treatment (main number untouched).
  const withExtras = await Organization.find({ 'extraNumbers.businessAccountId': wabaId, 'extraNumbers.isCoexistence': true }).select('_id ownerUserId').lean();
  for (const org of withExtras) {
    await Organization.updateOne({ _id: org._id }, {
      $set: {
        'extraNumbers.$[n].status': 'not_connected',
        'extraNumbers.$[n].accessTokenEncrypted': null,
        'extraNumbers.$[n].isCoexistence': false,
        'extraNumbers.$[n].coexistence.disconnectedFromPhoneAt': new Date(),
        'extraNumbers.$[n].lastError': 'The WhatsApp number was removed from Visitsly (via the phone’s Business Platform setting). Please reconnect.',
      },
    }, { arrayFilters: [{ 'n.businessAccountId': wabaId, 'n.isCoexistence': true }] });
    orgService.invalidate(org._id);
    if (org.ownerUserId) {
      await Notification.create({ userId: org.ownerUserId, type: 'whatsapp_connection', title: 'WhatsApp number disconnected', body: 'An extra number was removed from Visitsly on the phone. Please reconnect it.', link: '/whatsapp' }).catch(() => {});
    }
  }
}

module.exports = { handleEchoes, handleHistory, handleStateSync, handleAccountUpdate };
