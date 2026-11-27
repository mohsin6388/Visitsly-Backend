/**
 * Follow-up automation.
 *
 * Client Follow-ups page par "Setup" se chunta hai:
 *   manual = sirf AI suggestion (aap khud bhejte ho)
 *   remind = reply na aane par draft banta hai, due par notification
 *   auto   = reply na aane par khud WhatsApp bhejta hai (working hours ke andar)
 *
 * Reply aate hi / lead closed-lost hote hi / visit book hote hi pending follow-up band ho jata hai.
 * Free WhatsApp message sirf 24 ghante ke window me jata hai, baad me approved template chahiye.
 */
const Settings = require('../../models/Settings');
const FollowUp = require('../../models/FollowUp');
const Lead = require('../../models/Lead');
const Conversation = require('../../models/Conversation');
const Message = require('../../models/Message');
const Meeting = require('../../models/Meeting');
const Notification = require('../../models/Notification');
const metaWhatsappClient = require('../whatsapp/metaWhatsappClient');
const { recordOutboundMessage } = require('../whatsapp/messageStore');
const orgService = require('../saas/orgService');
const lang = require('../language');
const logger = require('../../utils/logger');

const DAY = 24 * 60 * 60 * 1000;
const TICK_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const MAX_SENDS_PER_TICK = 30;
const STOP_STATUSES = ['closed', 'lost', 'site_visit'];

const DEFAULTS = { mode: 'auto', gapsDays: [1, 3, 7], startHour: 10, endHour: 19, timezone: 'Asia/Kolkata', messages: [], useAiDate: true, templateName: '', templateLanguage: '', templateVariableCount: 0 };

const REENGAGE_TEXT = [
  'Hi {name}! Last time you said it wasn’t the right time — no problem 🙂 We have some new options and offers. Reply "Yes" if you’d like to see them.',
  'Hi {name}, just checking in — are you looking for a property now? Message us here anytime. (Reply STOP to opt out.)',
];

const DEFAULT_TEXT = [
  'Hi {name}! Following up on your property requirement. Are you still looking? Happy to help.',
  'Hi {name}, we have some good options ready for you. Would you like to book a site visit?',
  'Hi {name}, checking one last time. No worries if now isn’t the time — message us here whenever you need.',
  'Hi {name}, let us know if you’re still looking for a property — we’re here to help.',
];

function config(settings) {
  const f = settings?.followUp?.toObject ? settings.followUp.toObject() : (settings?.followUp || {});
  const gaps = Array.isArray(f.gapsDays) && f.gapsDays.length ? f.gapsDays : DEFAULTS.gapsDays;
  return { ...DEFAULTS, ...f, gapsDays: gaps };
}

function firstName(lead) {
  return String(lead?.name || '').trim().split(/\s+/)[0] || '';
}

function reengageText(cfg, lead, step) {
  const custom = String(cfg.reengage?.message || '').trim();
  const base = custom || REENGAGE_TEXT[Math.min(step - 1, REENGAGE_TEXT.length - 1)];
  return base.replace(/\{name\}/gi, firstName(lead) || 'ji').replace(/\s+([,!])/g, '$1');
}

/** The customer's saved chat language (E5); null when they never wrote. */
async function savedLanguage(lead, conversation = null) {
  return lang.normalize(conversation?.language) || (await lang.savedLanguageForLead(lead?._id));
}

/** Saved chat language, else the company default, else English (the old default texts). */
async function customerLanguage(lead, conversation = null, settings = null) {
  const saved = await savedLanguage(lead, conversation);
  if (saved) return saved;
  const s = settings || (await require('../settings/settingsService').getOrCreateSettings().catch(() => null));
  return lang.normalize(s?.assistant?.defaultLanguage) || 'English';
}

/**
 * Follow-up / re-engage text in the customer's language. Built-in texts come
 * from the language catalog; the company's own text is translated when the
 * customer chats in another language.
 */
async function stepText({ cfg, lead, step, kind = 'sequence', conversation = null, settings = null }) {
  const language = await customerLanguage(lead, conversation, settings);
  const custom = String(kind === 'reengage' ? cfg.reengage?.message || '' : cfg.messages?.[step - 1] || '').trim();
  if (custom) {
    const filled = custom.replace(/\{name\}/gi, firstName(lead) || 'ji').replace(/\s+([,!])/g, '$1');
    // The company's own words: translated only for a customer with a saved chat language.
    const saved = await savedLanguage(lead, conversation);
    return saved ? lang.translateText(filled, saved) : filled;
  }
  const key = kind === 'reengage' ? `reengage.${Math.min(step, 2)}` : `followup.${Math.min(step, 4)}`;
  return lang.t(key, language, { name: lang.nameVar(lead) });
}

/** First re-engage message for a lead, in their language (manual follow-up default). */
function reengageTextFor(cfg, lead, step = 1) {
  return stepText({ cfg, lead, step, kind: 'reengage' });
}

/**
 * Customer said "not interested / abhi nahi" (NOT "STOP"): politely ask again
 * after the configured gaps (default 7 and 30 days). Stops as soon as they
 * reply again, opt out, or the lead is closed/lost/visit booked.
 */
async function createReengageStep(cfg, conversation, lead) {
  const re = cfg.reengage || {};
  if (re.enabled === false || !conversation.declinedAt || conversation.optedOut || lead.optedOut) return null;
  if (!lead?.phone || STOP_STATUSES.includes(lead.status)) return null;
  const declinedAt = new Date(conversation.declinedAt).getTime();
  const lastIn = conversation.lastInboundAt ? new Date(conversation.lastInboundAt).getTime() : 0;
  // They wrote again after saying no (more than a few minutes later) → normal chat resumed.
  if (lastIn - declinedAt > 10 * 60 * 1000) return null;
  if (await FollowUp.exists({ leadId: lead._id, status: 'pending', kind: 'reengage' })) return null;
  const gaps = Array.isArray(re.gapsDays) && re.gapsDays.length ? re.gapsDays : [7, 30];
  const done = await FollowUp.countDocuments({ leadId: lead._id, kind: 'reengage', createdAt: { $gte: new Date(declinedAt) } });
  if (done >= gaps.length) return null;
  const due = declinedAt + gaps[done] * DAY;
  if (Date.now() < due) return null;
  return FollowUp.create({
    leadId: lead._id,
    ownerId: lead.ownerId,
    kind: 'reengage',
    step: done + 1,
    nextFollowUpDate: new Date(),
    nextFollowUpMessage: await stepText({ cfg, lead, step: done + 1, kind: 'reengage', conversation }),
    urgency: 'low',
    generatedBy: 'reengage',
  });
}

function hourIn(tz) {
  try {
    const h = parseInt(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: tz || DEFAULTS.timezone }).format(new Date()), 10);
    return h === 24 ? 0 : h;
  } catch {
    return new Date().getUTCHours();
  }
}

function inWorkingHours(cfg) {
  const h = hourIn(cfg.timezone);
  return h >= cfg.startHour && h < cfg.endHour;
}

/**
 * Ek follow-up ka message lead ko WhatsApp par bhejta hai aur status 'sent' karta hai.
 * Tenant context ke andar chalna chahiye. Fail par throw karta hai.
 */
async function sendFollowUpNow(followUp, { text } = {}) {
  const lead = await Lead.findById(followUp.leadId);
  if (!lead?.phone) throw new Error('Lead has no WhatsApp number');
  const conversation = await Conversation.findOne({ leadId: lead._id });
  if (!conversation) throw new Error('No WhatsApp chat with this lead yet — send the first message first');
  if (conversation.optedOut || lead.optedOut) throw new Error('Customer opted out (STOP)');
  const settings = await require('../settings/settingsService').getOrCreateSettings();
  const cfg = config(settings);
  let body = String(text || followUp.nextFollowUpMessage || '').trim();
  if (!body) throw new Error('Message is empty');
  // E5: automatic follow-ups go out in the customer's saved chat language
  // (text typed by the team is sent exactly as typed).
  if (!text && followUp.kind !== 'manual' && lang.normalize(conversation.language)) {
    body = await lang.translateText(body, conversation.language);
  }

  const lastInbound = conversation.lastInboundAt ? new Date(conversation.lastInboundAt).getTime() : 0;
  const windowOpen = Date.now() - lastInbound < DAY;

  let messageId = null;
  let shown = body;
  try {
    if (windowOpen) {
      ({ messageId } = await metaWhatsappClient.sendTextMessage({ phone: lead.phone, text: body }));
    } else if (cfg.templateName) {
      const values = [firstName(lead) || 'Customer', settings.companyName || 'our team'];
      const count = Math.min(Math.max(Number(cfg.templateVariableCount) || 0, 0), values.length);
      const components = count ? [{ type: 'body', parameters: values.slice(0, count).map((t) => ({ type: 'text', text: String(t) })) }] : [];
      const sent = await lang.sendTemplateInLanguage({
        phone: lead.phone,
        templateName: cfg.templateName,
        configuredLanguage: cfg.templateLanguage || 'en_US',
        language: lang.normalize(conversation.language), // saved language only; else the configured template
        buildComponents: () => components,
      });
      messageId = sent.messageId;
      shown = `[Follow-up template: ${cfg.templateName} · ${sent.languageCode}] ${body}`;
    } else {
      throw new Error('The lead has not messaged in 24 hours, so a free message is not allowed. Choose an approved template in Follow-ups → Setup.');
    }
  } catch (err) {
    err.message = String(err.metaError?.message || err.message);
    throw err;
  }

  await recordOutboundMessage({ conversationId: conversation._id, leadId: lead._id, text: shown, sender: 'ai', whatsappMessageId: messageId, ownerId: conversation.ownerId }).catch(() => {});
  followUp.status = 'sent';
  followUp.sentAt = new Date();
  followUp.lastError = null;
  followUp.nextFollowUpMessage = body;
  await followUp.save();
  return { sent: true, usedTemplate: !windowOpen };
}

/** Reply na aane par agla follow-up step banata hai (remind/auto mode). */
async function createSequenceStep(cfg, conversation, lead) {
  if (!lead?.phone || STOP_STATUSES.includes(lead.status)) return null;
  if (await FollowUp.exists({ leadId: lead._id, status: 'pending', kind: 'sequence' })) return null;

  const lastOut = await Message.findOne({ conversationId: conversation._id, direction: 'outbound' }).sort({ timestamp: -1 }).select('timestamp').lean();
  if (!lastOut) return null; // abhi tak koi message gaya hi nahi
  const lastOutAt = new Date(lastOut.timestamp).getTime();
  const lastInAt = conversation.lastInboundAt ? new Date(conversation.lastInboundAt).getTime() : 0;
  if (lastInAt > lastOutAt) return null; // lead ne jawab diya hai, ab hamari baari nahi

  const since = new Date(Math.max(lastInAt, new Date(lead.createdAt).getTime()));
  const done = await FollowUp.countDocuments({ leadId: lead._id, kind: 'sequence', createdAt: { $gte: since } });
  if (done >= cfg.gapsDays.length) return null;

  const due = lastOutAt + cfg.gapsDays[done] * DAY;
  if (Date.now() < due) return null;
  if (await Meeting.exists({ leadId: lead._id, status: { $in: ['scheduled', 'rescheduled'] } })) return null;

  return FollowUp.create({
    leadId: lead._id,
    ownerId: lead.ownerId,
    kind: 'sequence',
    step: done + 1,
    nextFollowUpDate: new Date(),
    nextFollowUpMessage: await stepText({ cfg, lead, step: done + 1, kind: 'sequence', conversation }),
    urgency: done + 1 >= cfg.gapsDays.length ? 'low' : 'medium',
    generatedBy: 'sequence',
  });
}

async function notifyDue(followUp, lead, cfg) {
  await Notification.create({
    userId: followUp.ownerId,
    type: 'follow_up_due',
    title: `Follow-up due: ${lead?.name || 'Lead'}`,
    body: String(followUp.nextFollowUpMessage || '').slice(0, 200),
    link: '/follow-ups',
  }).catch(() => {});
  await FollowUp.updateOne({ _id: followUp._id }, { $set: { notifiedAt: new Date() } });
}

async function processOrg(settings) {
  const cfg = config(settings);
  if (cfg.mode === 'manual') return;
  // Automatic follow-ups are a Growth+ feature. Without it the follow-ups are
  // still created and the team is reminded, but nothing is sent automatically.
  const { hasFeature } = require('../saas/subscription');
  if (cfg.mode === 'auto' && !hasFeature(require('../../context/tenantContext').getOrg(), 'autoFollowUps')) cfg.mode = 'remind';
  const now = new Date();

  // 1) Jin leads ko ab follow-up nahi chahiye (closed/lost/visit book), unke pending band
  const stopLeadIds = await Lead.distinct('_id', { status: { $in: STOP_STATUSES } });
  if (stopLeadIds.length) {
    await FollowUp.updateMany({ status: 'pending', leadId: { $in: stopLeadIds } }, { $set: { status: 'skipped' } });
  }

  // 2) Reply na aane wali chats ke liye naya step banao
  const convs = await Conversation.find({ status: { $in: ['ai_active', 'manual'] }, optedOut: { $ne: true }, lastMessageAt: { $gte: new Date(Date.now() - 45 * DAY) } }).limit(500);
  for (const conversation of convs) {
    try {
      const lead = await Lead.findById(conversation.leadId);
      if (lead && !lead.optedOut && !conversation.declinedAt) await createSequenceStep(cfg, conversation, lead);
    } catch (err) {
      logger.warn('[followup-auto] Step create failed', { error: err.message });
    }
  }

  // 2b) "Not interested" walon ko kuch din baad politely dobara poochna
  const declined = await Conversation.find({ declinedAt: { $ne: null, $gte: new Date(Date.now() - 120 * DAY) }, optedOut: { $ne: true } }).limit(300);
  for (const conversation of declined) {
    try {
      const lead = await Lead.findById(conversation.leadId);
      if (lead) await createReengageStep(cfg, conversation, lead);
    } catch (err) {
      logger.warn('[followup-auto] Re-engage step failed', { error: err.message });
    }
  }

  // 3) Due follow-ups: notify ya bhejo
  const due = await FollowUp.find({ status: 'pending', nextFollowUpDate: { $lte: now } }).sort({ nextFollowUpDate: 1 }).limit(100);
  let sends = 0;
  for (const fu of due) {
    try {
      const lead = await Lead.findById(fu.leadId);
      if (!lead) { fu.status = 'skipped'; await fu.save(); continue; }
      const conversation = await Conversation.findOne({ leadId: lead._id });
      const lastIn = conversation?.lastInboundAt ? new Date(conversation.lastInboundAt).getTime() : 0;

      // Lead ne is draft ke baad jawab de diya = follow-up ki zarurat nahi
      if (['sequence', 'reengage'].includes(fu.kind) && lastIn > new Date(fu.createdAt).getTime()) { fu.status = 'skipped'; await fu.save(); continue; }
      if (conversation?.optedOut || lead.optedOut) { fu.status = 'skipped'; fu.lastError = 'Customer ne STOP likha'; await fu.save(); continue; }

      const autoOk = cfg.mode === 'auto' && (['sequence', 'reengage', 'manual'].includes(fu.kind) || cfg.useAiDate) && fu.attempts < MAX_ATTEMPTS && conversation && conversation.status !== 'closed';
      if (!autoOk) {
        if (!fu.notifiedAt) await notifyDue(fu, lead, cfg);
        continue;
      }
      if (!inWorkingHours(cfg) || sends >= MAX_SENDS_PER_TICK) continue;
      if (fu.kind === 'ai' && lastIn > new Date(fu.updatedAt).getTime()) continue; // naya reply abhi analyse hona baaki

      try {
        await sendFollowUpNow(fu);
        sends += 1;
      } catch (err) {
        fu.attempts += 1;
        fu.lastError = String(err.message).slice(0, 300);
        await fu.save();
        if (!fu.notifiedAt) await notifyDue(fu, lead, cfg); // auto nahi ja paya, aap dekh lijiye
        logger.warn('[followup-auto] Send failed', { followUp: String(fu._id), error: err.message });
      }
    } catch (err) {
      logger.warn('[followup-auto] Follow-up processing failed', { error: err.message });
    }
  }
}

async function tick() {
  // Missing mode = default (auto). Only companies that explicitly chose "manual" are skipped.
  const companies = await Settings.find({ 'followUp.mode': { $ne: 'manual' } }).select('orgId followUp companyName').lean();
  for (const s of companies) {
    try {
      if (s.orgId) await orgService.runForOrg(s.orgId, () => processOrg(s));
      else await processOrg(s);
    } catch (err) {
      logger.error('[followup-auto] Company tick failed', { error: err.message });
    }
  }
}

let handle = null;
function startFollowUpScheduler() {
  if (handle) return;
  const { withLock } = require('../../utils/distributedLock');
  handle = setInterval(() => withLock('followups', TICK_MS - 10000, tick).catch((err) => logger.error('[followup-auto] tick failed', { error: err.message })), TICK_MS);
  logger.info('[followup-auto] Scheduler started (every 10 min)');
}

module.exports = { startFollowUpScheduler, sendFollowUpNow, tick, config, DEFAULT_TEXT, REENGAGE_TEXT, reengageText, reengageTextFor, stepText, customerLanguage };
