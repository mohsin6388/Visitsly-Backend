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
const logger = require('../../utils/logger');

const DAY = 24 * 60 * 60 * 1000;
const TICK_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const MAX_SENDS_PER_TICK = 30;
const STOP_STATUSES = ['closed', 'lost', 'site_visit'];

const DEFAULTS = { mode: 'auto', gapsDays: [1, 3, 7], startHour: 10, endHour: 19, timezone: 'Asia/Kolkata', messages: [], useAiDate: true, templateName: '', templateLanguage: '', templateVariableCount: 0 };

const REENGAGE_TEXT = [
  'Namaste {name}! Pichhli baar aapne bataya tha ki abhi zarurat nahi hai — koi baat nahi 🙂 Kuch naye options aur offers aaye hain. Agar aap dekhna chahein to bas "Haan" likh dijiye.',
  'Namaste {name}, bas ek baar check kar rahe the — kya ab aap property dekh rahe hain? Zarurat ho to yahin message kar dijiye, hum turant madad karenge. (Message band karwane ke liye STOP likhein.)',
];

const DEFAULT_TEXT = [
  'Namaste {name}! Aapki property requirement par aage baat karni thi. Kya aap abhi dekh rahe hain? Bataiye, main madad kar dun.',
  'Namaste {name}, aapke liye kuch achhe options aur details ready hain. Chahein to site visit bhi book kar dein, bas bata dijiye.',
  'Namaste {name}, aakhri baar pooch raha hoon. Agar abhi zarurat nahi hai to koi baat nahi, jab bhi chahiye ho yahin message kar dena.',
  'Namaste {name}, agar aap abhi bhi property dekh rahe hain to bataiye, hum madad ke liye taiyaar hain.',
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
    nextFollowUpMessage: reengageText(cfg, lead, done + 1),
    urgency: 'low',
    generatedBy: 'reengage',
  });
}

function sequenceText(cfg, lead, step) {
  const custom = String(cfg.messages?.[step - 1] || '').trim();
  const base = custom || DEFAULT_TEXT[Math.min(step - 1, DEFAULT_TEXT.length - 1)];
  return base.replace(/\{name\}/gi, firstName(lead) || 'ji').replace(/\s+([,!])/g, '$1');
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
  if (!lead?.phone) throw new Error('Lead ka WhatsApp number nahi hai');
  const conversation = await Conversation.findOne({ leadId: lead._id });
  if (!conversation) throw new Error('Is lead ki WhatsApp chat shuru nahi hui, pehle pehla message bhejein');
  if (conversation.optedOut || lead.optedOut) throw new Error('Customer ne STOP likh kar messages band karwaye hain');
  const settings = await require('../settings/settingsService').getOrCreateSettings();
  const cfg = config(settings);
  const body = String(text || followUp.nextFollowUpMessage || '').trim();
  if (!body) throw new Error('Message khali hai');

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
      ({ messageId } = await metaWhatsappClient.sendTemplateMessage({ phone: lead.phone, templateName: cfg.templateName, languageCode: cfg.templateLanguage || 'en_US', components }));
      shown = `[Follow-up template: ${cfg.templateName}] ${body}`;
    } else {
      throw new Error('Lead ne 24 ghante se message nahi kiya, isliye free message nahi ja sakta. Follow-ups page par "Setup" me ek approved template chunein.');
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
    nextFollowUpMessage: sequenceText(cfg, lead, done + 1),
    urgency: done + 1 >= cfg.gapsDays.length ? 'low' : 'medium',
    generatedBy: 'sequence',
  });
}

async function notifyDue(followUp, lead, cfg) {
  await Notification.create({
    userId: followUp.ownerId,
    type: 'follow_up_due',
    title: `Follow-up ka time: ${lead?.name || 'Lead'}`,
    body: String(followUp.nextFollowUpMessage || '').slice(0, 200),
    link: '/follow-ups',
  }).catch(() => {});
  await FollowUp.updateOne({ _id: followUp._id }, { $set: { notifiedAt: new Date() } });
}

async function processOrg(settings) {
  const cfg = config(settings);
  if (cfg.mode === 'manual') return;
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

module.exports = { startFollowUpScheduler, sendFollowUpNow, tick, config, DEFAULT_TEXT, REENGAGE_TEXT, reengageText };
