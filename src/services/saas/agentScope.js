/**
 * Agent data scope + phone masking — ONE place, used by every controller.
 *
 * An agent (orgRole 'agent') sees only leads assigned to them (Lead.assignedTo, the
 * field lead routing writes) and everything tied to those leads: chats, WhatsApp
 * leads, site visits, follow-ups, notifications and dashboard numbers. The Owner
 * sees everything. This is always on for agents; the old company-wide
 * `routing.agentsSeeOnlyAssigned` flag is kept for compatibility but no longer needed.
 *
 * Phone masking: an agent without `showFullPhone` only ever receives the last 4
 * digits (masked in auth.js for every JSON response, and in the socket layer).
 */
const mongoose = require('mongoose');
const Lead = require('../../models/Lead');
const ApiError = require('../../utils/ApiError');

const oid = (v) => new mongoose.Types.ObjectId(String(v));
const isOid = (v) => /^[a-f\d]{24}$/i.test(String(v || ''));

/** True for a logged-in company agent (never for the owner, support sessions or legacy single-client mode). */
const isAgent = (req) => Boolean(req?.user?.tenant && req.user.orgRole === 'agent');

/** Filter for Lead queries: `{ ownerId }` for the owner, plus `assignedTo` for an agent. */
function leadScope(req) {
  const base = { ownerId: req.user.id };
  return isAgent(req) ? { ...base, assignedTo: req.user.actorId } : base;
}

/** Ids of the leads this agent may see (cached per request). Owner: null = no restriction. */
async function assignedLeadIds(req) {
  if (!isAgent(req)) return null;
  if (!req._assignedLeadIds) req._assignedLeadIds = await Lead.find({ ownerId: req.user.id, assignedTo: req.user.actorId }).distinct('_id');
  return req._assignedLeadIds;
}

/**
 * Filter for any collection keyed by a lead id (conversations, messages, meetings, follow-ups, quotes…).
 * Owner → {} ; agent → { [field]: { $in: assignedLeadIds } }.
 */
async function byLeadFilter(req, field = 'leadId') {
  const ids = await assignedLeadIds(req);
  return ids === null ? {} : { [field]: { $in: ids } };
}

/** 404 unless the lead exists in this workspace AND (for an agent) is assigned to them — prevents IDOR. */
async function assertLeadVisible(req, leadId, notFound = 'Lead not found') {
  if (!isOid(leadId)) throw ApiError.notFound(notFound);
  const lead = await Lead.findOne({ _id: leadId, ...leadScope(req) }).select('_id').lean();
  if (!lead) throw ApiError.notFound(notFound);
  return lead;
}

/* ------------------------------ phone masking ------------------------------ */
const mustMask = (req) => isAgent(req) && req.user.permissions?.showFullPhone !== true;

/** "9876543210" → "••••••3210" (last 4 digits only). Empty stays empty. */
function maskPhone(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return value === 0 ? value : '';
  return `••••••${digits.slice(-4)}`;
}

// JSON keys that carry a phone number anywhere in our payloads.
const PHONE_KEYS = new Set([
  'phone', 'phonenumber', 'mobile', 'mobilenumber', 'whatsapp', 'whatsappnumber', 'waid', 'wa_id',
  'contactphone', 'customerphone', 'leadphone', 'displayphone', 'altphone', 'alternatephone', 'msisdn',
]);
// A phone-looking run of digits inside free text (notification titles / bodies).
const PHONE_IN_TEXT = /(\+?\d[\d\s().-]{7,}\d)/g;
const maskPhonesInText = (text) => String(text).replace(PHONE_IN_TEXT, (m) => (m.replace(/\D/g, '').length >= 8 ? maskPhone(m) : m));
const TEXT_KEYS = new Set(['title', 'body', 'notificationbody', 'alert']);

/** Deep-copies a JSON-able payload with every phone number masked. Message text is never touched. */
function maskPayload(value, key = '') {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => maskPayload(v, key));
  if (typeof value === 'object') {
    if (value instanceof Date) return value;
    const plain = typeof value.toJSON === 'function' ? value.toJSON() : value;
    if (plain !== value) return maskPayload(plain, key);
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = maskPayload(v, k);
    return out;
  }
  const lower = key.toLowerCase();
  if (PHONE_KEYS.has(lower) && (typeof value === 'string' || typeof value === 'number')) return maskPhone(value);
  if (TEXT_KEYS.has(lower) && typeof value === 'string') return maskPhonesInText(value);
  return value;
}

/** Search text for masked agents: a phone search may only match the last 4 digits. */
function safeSearchText(req, text) {
  const q = String(text || '').trim();
  if (!q || !mustMask(req)) return q;
  const digits = q.replace(/\D/g, '');
  if (digits.length > 4 && digits.length >= q.replace(/[\s+()-]/g, '').length) return ''; // a full number → ignore
  return q;
}

/** Lead / conversation ids named by a notification link (?lead=ID, ?id=CONVERSATION, /leads/ID). */
function idsInLink(link) {
  const text = String(link || '');
  return {
    leadId: (text.match(/\/leads\/([a-f\d]{24})/i) || text.match(/[?&]lead=([a-f\d]{24})/i) || [])[1] || null,
    conversationId: (text.match(/[?&]id=([a-f\d]{24})/i) || [])[1] || null,
  };
}

module.exports = {
  oid, isOid, isAgent, leadScope, assignedLeadIds, byLeadFilter, assertLeadVisible,
  mustMask, maskPhone, maskPayload, maskPhonesInText, safeSearchText, idsInLink, PHONE_KEYS,
};
