/* eslint-disable no-console */
/**
 * Lead call (enquiry) smoke test — no database. Checks that a visit agreed on
 * a lead call lands in Site visits (confirmed by call), the requirement is
 * saved on the lead, and an "interested, not now" call becomes a follow-up.
 *   node test/voice-leadcall.smoke.js
 */
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const M = (p) => require(path.join(root, 'src/models', p));
process.env.GEMINI_API_KEY = 'test';

const Lead = M('Lead'); const Meeting = M('Meeting'); const CallLog = M('CallLog');
const Conversation = M('Conversation'); const Property = M('Property'); const FollowUp = M('FollowUp');
const lean = (v) => ({ select: () => ({ lean: async () => v }), lean: async () => v, sort: () => ({ select: () => ({ lean: async () => v }) }) });
const calls = { lead: [], followUps: [], meetingsSaved: [], posts: [] };
const lead = { _id: 'L1', ownerId: 'O1', name: 'Ravi Kumar', phone: '919800000000', status: 'new', requirements: '', project: null };
Lead.findById = async () => ({ ...lead });
Lead.updateOne = async (q, u) => { calls.lead.push(u.$set); return {}; };
CallLog.findOneAndUpdate = async () => ({});
CallLog.updateOne = async () => ({});
Conversation.findOne = () => lean({ _id: 'C1' });
Conversation.updateOne = async () => ({});
Property.findOne = () => lean({ _id: 'P1' });
Meeting.findOne = () => ({ sort: async () => null });
Meeting.findById = async () => null;
Meeting.prototype.save = async function save() { calls.meetingsSaved.push(this.toObject()); return this; };
FollowUp.updateMany = async () => ({});
FollowUp.findOneAndUpdate = async (q, u) => { calls.followUps.push(u); return u; };
require(path.join(root, 'src/services/calendar/googleCalendarService')).createCalendarEvent = async () => null;
const vc = require(path.join(root, 'src/services/visits/visitConfirmation'));
vc.afterCallOutcome = async (meeting, l, outcome) => { calls.posts.push(outcome); };
require(path.join(root, 'src/services/settings/settingsService')).getGeminiKey = async () => 'test';

let answer = null;
global.fetch = async (url, opts) => {
  calls.lastPrompt = JSON.parse(opts.body).system_instruction.parts[0].text;
  const body = JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] }, finishReason: 'STOP' }] });
  return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) };
};

(async () => {
  const agent = require(path.join(root, 'src/services/voice/voiceAgent'));
  const voice = require(path.join(root, 'src/services/voice/voiceService'));
  const ctx = { purpose: 'enquiry', orgId: 'org', name: 'Ravi', project: 'Green Park', language: 'hi' };
  const turns = [
    { role: 'agent', text: 'नमस्ते रवि जी…' },
    { role: 'customer', text: '3 BHK chahiye Wakad mein, budget 1.2 crore tak' },
    { role: 'agent', text: 'Green Park में 3 BHK है…' },
    { role: 'customer', text: 'theek hai Sunday ko dekhne aa jaunga' },
  ];

  // 1) visit agreed on a lead call (no time said) → booking at 11:00 + requirement
  answer = { visit: 'confirmed', new_date: '2099-01-04', new_time: null, interested: true, summary: 'Wants 3 BHK in Wakad, visiting Sunday.', lead: { looking_for: 'buy', location: 'Wakad', bhk: '3', budget_max_inr: 12000000, project: 'Green Park', requirement: '3 BHK in Wakad up to 1.2 Cr' } };
  const out = await agent.extractOutcome(ctx, turns);
  assert(/LEAD CALL/.test(calls.lastPrompt), 'lead-call extraction instructions used');
  assert.strictEqual(out.visit, 'confirmed');
  assert.strictEqual(out.new_time, '11:00');
  assert.strictEqual(out.lead.budget_max_inr, 12000000);
  await voice.applyOutcome({ _id: 'CL1', ownerId: 'O1', leadId: 'L1', trigger: 'manual', purpose: 'enquiry', context: ctx, extracted: { ...out } });
  const m = calls.meetingsSaved[0];
  assert(m, 'site visit created');
  assert.strictEqual(m.preferredDate, '2099-01-04');
  assert.strictEqual(m.confirmation.status, 'confirmed');
  assert.strictEqual(m.confirmation.confirmedVia, 'call');
  assert.strictEqual(m.source, 'voice_ai');
  assert(calls.posts.includes('confirmed'), 'WhatsApp confirmation with details sent');
  assert(calls.lead.some((u) => u.budgetMax === 12000000 && u.location === 'Wakad'), 'requirement saved on the lead');
  assert(calls.lead.some((u) => u.status === 'site_visit'), 'lead moved to site visit');
  console.log('  ✓ visit booked on a lead call → Site visits (confirmed by call) + lead updated');

  // 2) interested but not ready → follow-up
  calls.meetingsSaved = []; calls.followUps = [];
  answer = { visit: 'unknown', interested: true, summary: 'Interested, will decide next week.', lead: null };
  const out2 = await agent.extractOutcome(ctx, turns);
  await voice.applyOutcome({ _id: 'CL2', ownerId: 'O1', leadId: 'L1', trigger: 'manual', purpose: 'enquiry', context: ctx, extracted: { ...out2 } });
  assert(!calls.meetingsSaved.length, 'no visit without a date');
  assert(calls.followUps.length === 1 && calls.followUps[0].urgency === 'high', 'hot follow-up created');
  console.log('  ✓ interested without a date → follow-up');

  // 3) prompt for lead calls carries properties, profile and chat
  const p = agent.realtimePrompt({ ...ctx, facts: '1. Green Park · Wakad · 3 BHK', leadProfile: 'Budget: 1.2 crore', chat: 'Customer: 3bhk?' });
  assert(/OUR PROPERTIES/.test(p) && /WHAT WE KNOW ABOUT THE CUSTOMER/.test(p) && /RECENT WHATSAPP CHAT/.test(p) && !/press 1/i.test(p));
  console.log('  ✓ lead-call prompt has properties, profile and WhatsApp chat');
  console.log('✓ lead call smoke test passed');
  process.exit(0);
})().catch((err) => { console.error('✗', err); process.exit(1); });
