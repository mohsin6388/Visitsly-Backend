const crypto = require('crypto');
const Lead = require('../../models/Lead');
const Conversation = require('../../models/Conversation');
const Notification = require('../../models/Notification');
const Organization = require('../../models/Organization');
const tenantContext = require('../../context/tenantContext');
const orgService = require('../saas/orgService');
const { autoAssign } = require('./routing');
const { emitToUser } = require('../../sockets');
const logger = require('../../utils/logger');

/**
 * Single entry point for every lead that ARRIVES on its own: website form,
 * hosted form link, Google Ads lead form, Meta lead ads, portal emails
 * (99acres / MagicBricks / Housing), channel partners.
 *
 * - Dedupes on phone / email inside the company (repeat enquiries bump
 *   captureCount and add a note instead of creating a duplicate).
 * - Round-robin assigns (if routing is on).
 * - Starts the WhatsApp opening template right away (if autoWhatsapp).
 * Inbound leads are paid-for leads, so they are always saved even when the
 * company is at its contacts limit (the owner gets a notification).
 */
function newKey() {
  return crypto.randomBytes(12).toString('hex');
}

async function ensureCaptureKey(orgId) {
  const org = await Organization.findById(orgId).select('leadCapture.key').lean();
  if (org?.leadCapture?.key) return org.leadCapture.key;
  const key = newKey();
  await Organization.updateOne({ _id: orgId, 'leadCapture.key': { $in: [null, undefined] } }, { $set: { 'leadCapture.key': key } });
  orgService.invalidate(orgId);
  const fresh = await Organization.findById(orgId).select('leadCapture.key').lean();
  return fresh.leadCapture.key;
}

async function orgByCaptureKey(key) {
  if (!key || !/^[a-f0-9]{24}$/.test(String(key))) return null;
  const org = await Organization.findOne({ 'leadCapture.key': key }).select('_id').lean();
  return org ? orgService.getSnapshot(org._id) : null;
}

function normalizePhone(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/[^\d]/g, '');
  if (digits.startsWith('0') && digits.length === 11) digits = digits.slice(1);
  if (digits.length === 10) digits = `91${digits}`;
  if (digits.length < 10 || digits.length > 15) return null;
  return digits;
}

const clean = (v, n = 200) => (v === undefined || v === null ? undefined : String(v).trim().slice(0, n) || undefined);

/**
 * Must run inside the company's tenant context.
 * input: { name, phone, email, source, sourceDetail, project, city, location,
 *          budgetMin, budgetMax, message, externalId, channelPartnerId, cpProtectedUntil }
 */
async function captureLead(input) {
  const org = tenantContext.getOrg();
  if (!org) throw new Error('captureLead needs a tenant context');
  const ownerId = org.ownerUserId;
  const phone = normalizePhone(input.phone);
  const email = clean(input.email, 200)?.toLowerCase();
  if (!phone && !email) return { lead: null, created: false, reason: 'no_contact' };

  if (input.externalId) {
    const seen = await Lead.findOne({ ownerId, externalId: input.externalId });
    if (seen) return { lead: seen, created: false, reason: 'duplicate_event' };
  }

  const or = [];
  if (phone) or.push({ phone }, { phone: `+${phone}` });
  if (email) or.push({ email });
  let lead = await Lead.findOne({ ownerId, $or: or });
  const noteLine = [
    `[${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}] Enquiry via ${input.source || 'form'}`,
    input.sourceDetail ? `(${input.sourceDetail})` : '',
    input.project ? `— ${input.project}` : '',
    input.message ? `: ${clean(input.message, 1000)}` : '',
  ].filter(Boolean).join(' ');

  if (lead) {
    lead.captureCount = (lead.captureCount || 1) + 1;
    lead.lastCapturedAt = new Date();
    lead.notes = [lead.notes, noteLine].filter(Boolean).join('\n').slice(-5000);
    if (!lead.email && email) lead.email = email;
    if (!lead.phone && phone) lead.phone = phone;
    if (input.project && !lead.project) lead.project = clean(input.project);
    const tag = `repeat:${input.source || 'form'}`;
    if (!lead.tags.includes(tag)) lead.tags.push(tag);
    await lead.save();
    await Notification.create({ userId: ownerId, type: 'repeat_enquiry', title: `${lead.name} ne dobara enquiry ki`, body: noteLine.slice(0, 300), link: `/whatsapp/conversations?lead=${lead._id}` }).catch(() => {});
    emitToUser(ownerId, 'notification:new', {});
    return { lead, created: false, reason: 'repeat' };
  }

  try {
    lead = await Lead.create({
      ownerId,
      name: clean(input.name, 150) || (email ? email.split('@')[0] : `Lead ${String(phone).slice(-4)}`),
      phone,
      email,
      city: clean(input.city, 80),
      location: clean(input.location, 120),
      budgetMin: Number(input.budgetMin) || null,
      budgetMax: Number(input.budgetMax) || null,
      source: clean(input.source, 60) || 'website_form',
      sourceDetail: clean(input.sourceDetail, 200) || null,
      project: clean(input.project, 150) || null,
      requirements: clean(input.message, 2000),
      notes: noteLine,
      captureCount: 1,
      lastCapturedAt: new Date(),
      externalId: input.externalId || null,
      channelPartnerId: input.channelPartnerId || null,
      cpProtectedUntil: input.cpProtectedUntil || null,
      tags: [input.source || 'website_form'],
    });
  } catch (err) {
    if (err.code === 11000) return captureLead(input); // concurrent duplicate — merge path
    throw err;
  }

  if (phone) {
    await Conversation.updateOne({ ownerId, leadId: lead._id }, { $setOnInsert: { ownerId, leadId: lead._id } }, { upsert: true }).catch(() => {});
  }

  const assignee = await autoAssign(org, lead).catch((err) => { logger.warn('[capture] auto-assign failed', { error: err.message }); return null; });

  await Notification.create({
    userId: ownerId,
    type: 'new_lead',
    title: `Nayi lead: ${lead.name}`,
    body: `${input.source || 'Form'}${lead.project ? ` · ${lead.project}` : ''}${assignee ? ` · ${assignee.name} ko assign` : ''}`,
    link: `/whatsapp/conversations?lead=${lead._id}`,
  }).catch(() => {});
  emitToUser(ownerId, 'notification:new', {});

  // Reply in under a minute: start WhatsApp straight away.
  if (phone && org.leadCapture?.autoWhatsapp !== false) {
    try {
      const { enqueueLeads } = require('../queue/outboundQueue');
      await enqueueLeads({ ownerId, leadIds: [lead._id] });
    } catch (err) {
      logger.warn('[capture] Could not queue opening WhatsApp', { error: err.message });
    }
  }

  // Contacts limit: still saved (paid lead), but tell the owner.
  try {
    const { checkLimit } = require('../saas/subscription');
    const count = await Lead.countDocuments({ ownerId });
    const lim = checkLimit(org, 'contacts', count - 1, 1);
    if (!lim.ok) {
      await Notification.create({ userId: ownerId, type: 'plan_limit', title: 'Contacts limit cross ho gayi', body: 'Nayi inbound leads abhi bhi save ho rahi hain, lekin upload/manual add band hai. Plan upgrade karein.', link: '/billing' });
    }
  } catch { /* best effort */ }

  return { lead, created: true, assignee };
}

module.exports = { captureLead, ensureCaptureKey, orgByCaptureKey, normalizePhone, newKey };
