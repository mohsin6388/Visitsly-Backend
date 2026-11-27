/* eslint-disable no-console */
/**
 * Smoke test (no database) for the WhatsApp AI + AI calling changes:
 *   • one reply when the customer sends several messages (pre-send check)
 *   • messages sent before the reply are read together
 *   • bot-loop / junk detection
 *   • prompt: company bot name, no real example projects, pitch only for the
 *     platform owner, Hindi = Devanagari, WhatsApp list format
 *   • property media: offered only when uploaded, "haan" sends it, max 5 photos
 *   • calls: region / STOP / DND / friendly errors, call-later → re-call,
 *     not reached → retry then WhatsApp
 *   node test/chat-and-calls.smoke.js
 */
const path = require('path');
const assert = require('assert');

process.env.GEMINI_API_KEY = 'test';
const root = path.join(__dirname, '..');
const R = (p) => require(path.join(root, 'src', p));

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n`, err);
    process.exitCode = 1;
  }
}

/* ------------------------------------------------------------------ */
/* Stubs (installed before the engine is loaded — it destructures some) */
/* ------------------------------------------------------------------ */
const sent = { text: [], images: [], docs: [], templates: [] };
const state = { newer: false, recent: [], geminiReply: null, convUpdates: [], leadUpdates: [], props: [] };

const settingsObj = {
  autoReplyEnabled: true,
  aiPaused: false,
  whatsappDisconnected: false,
  assistant: { name: 'Priya', gender: 'female', instructions: 'Highlight the metro.' },
  referral: { enabled: true },
  visitConfirm: { callEnabled: false, callStartHour: 0, callEndHour: 24 },
  followUp: { templateName: 'followup_1', templateLanguage: 'en', templateVariableCount: 1 },
  companyName: 'ABC Realty',
  calling: { dnd: { enabled: false } },
};
const settingsService = R('services/settings/settingsService');
settingsService.getOrCreateSettings = async () => settingsObj;
settingsService.getGeminiKey = async () => 'k';

const Message = R('models/Message');
const chain = (v) => ({ sort: () => ({ limit: () => ({ lean: async () => v, select: () => ({ lean: async () => v }) }) }) });
Message.find = () => chain([...state.recent].reverse());
Message.exists = async () => state.newer;
Message.countDocuments = async () => 0;

const Conversation = R('models/Conversation');
Conversation.updateOne = async (q, u) => { state.convUpdates.push(u); return { modifiedCount: 1 }; };
Conversation.findById = () => ({ select: () => ({ lean: async () => ({ aiReplyCount: 0 }) }) });
Conversation.findOneAndUpdate = () => ({ select: () => ({ lean: async () => ({ aiReplyCount: 1 }) }) });
Conversation.exists = async () => false;

const Meeting = R('models/Meeting');
Meeting.findOne = () => ({ sort: () => ({ populate: () => ({ lean: () => Promise.resolve(null) }) }) });
Meeting.exists = async () => false;

const Lead = R('models/Lead');
Lead.updateOne = async (q, u) => { state.leadUpdates.push(u); return {}; };

const Property = R('models/Property');
Property.findById = async (id) => state.props.find((p) => String(p._id) === String(id)) || null;
Property.findOne = async () => null;

const wa = R('services/whatsapp/metaWhatsappClient');
wa.sendToLead = async ({ text }) => { sent.text.push(text); return { messageId: `m${sent.text.length}` }; };
wa.sendTextMessage = async ({ text }) => { sent.text.push(text); return { messageId: 't' }; };
wa.sendImageMessage = async ({ imageUrl }) => { sent.images.push(imageUrl); return { messageId: 'i' }; };
wa.sendDocumentMessage = async ({ documentUrl }) => { sent.docs.push(documentUrl); return { messageId: 'd' }; };
wa.sendTemplateMessage = async ({ templateName }) => { sent.templates.push(templateName); return { messageId: 'tpl' }; };

R('services/whatsapp/messageStore').recordOutboundMessage = async (m) => ({ _id: 'out', ...m });
R('services/ai/propertyMatcher').matchProperties = async () => state.props;
R('services/sites/siteBrochure').attachSiteBrochure = async (p) => p;
R('services/ai/leadAnalyzer').analyzeConversationAsync = async () => {};
R('sockets').emitToUser = () => {};
let geminiPrompts = [];
R('services/ai/geminiClient').generateStructured = async ({ systemInstruction, history }) => {
  geminiPrompts.push({ systemInstruction, history });
  return { parsed: state.geminiReply, raw: '{}' };
};

const engine = R('services/ai/conversationEngine');
const promptBuilder = R('services/ai/promptBuilder');
const guard = R('services/ai/replyGuard');
const policy = R('services/voice/callPolicy');

const baseReply = (reply, extra = {}) => ({
  reply, name: null, phone: null, preferred_language: null, property_type: null, budget: null, location_preference: null,
  purpose: null, timeline: null, interest_level: 'pata nahi', verified: false, notes: null, lead_type: 'buyer',
  assistant_interest: 'pata nahi', send_property_media: false, property_reference: null,
  extractedRequirements: { projectName: null, city: null, location: null, budgetMin: null, budgetMax: null, bhk: null, propertyType: null, amenities: [] },
  ...extra,
});

function makeConversation(extra = {}) {
  return {
    _id: 'C1', ownerId: 'O1', status: 'ai_active', collectedRequirements: {}, recommendedProperties: [], language: 'Hinglish',
    referralStatus: 'none', mediaOffer: { propertyId: null, kind: null, at: null }, currentPropertyId: null,
    async save() { return this; },
    ...extra,
  };
}
const lead = { _id: 'L1', ownerId: 'O1', name: 'Ravi', phone: '919800000000' };
const reset = () => { sent.text = []; sent.images = []; sent.docs = []; sent.templates = []; state.convUpdates = []; state.leadUpdates = []; geminiPrompts = []; };

(async () => {
  console.log('chat + calls smoke test');

  /* ---------------- double reply ---------------- */
  await test('two quick messages → the older run does not reply', async () => {
    reset();
    state.props = [];
    state.recent = [
      { _id: 'a1', direction: 'outbound', text: 'Kab visit karenge?' },
      { _id: 'a2', direction: 'inbound', type: 'text', text: 'me soch rha hoon' },
      { _id: 'a3', direction: 'inbound', type: 'text', text: 'budget 80 lakh hai' },
    ];
    state.newer = true; // message a3 arrived after a2
    state.geminiReply = baseReply('Koi baat nahi');
    await engine.handleInbound({ conversation: makeConversation(), lead, message: { _id: 'a2', type: 'text', text: 'me soch rha hoon' } });
    assert.strictEqual(sent.text.length, 0, 'older run must not send');
  });

  await test('the newest run replies once and reads both messages together', async () => {
    reset();
    state.newer = false;
    state.geminiReply = baseReply('Bilkul! Kal kitne baje aana theek rahega?');
    await engine.handleInbound({ conversation: makeConversation(), lead, message: { _id: 'a3', type: 'text', text: 'budget 80 lakh hai' } });
    assert.strictEqual(sent.text.length, 1);
    const p = geminiPrompts[0];
    assert.ok(p.systemInstruction.includes('me soch rha hoon\nbudget 80 lakh hai'), 'both unanswered messages are the current message');
    const userTurns = p.history.filter((t) => t.role === 'user');
    assert.strictEqual(userTurns.length, 1, 'back-to-back customer messages merged into one turn');
  });

  /* ---------------- guard ---------------- */
  await test('bot / junk detection', async () => {
    assert.ok(guard.looksLikeBot("I'm sorry, I didn't understand that!"));
    assert.ok(guard.looksLikeBot('Please select an option:\n1. Sales\n2. Support\n3. Accounts'));
    assert.ok(!guard.looksLikeBot('Mujhe 2 BHK chahiye Noida mein'));
    assert.ok(guard.isJunk('😂😂😂'));
    assert.ok(guard.isJunk('sdfghjkl'));
    assert.ok(guard.isJunk('hello', 'Hello'));
    assert.ok(!guard.isJunk('ok'));
    assert.ok(!guard.isJunk('price kya hai?', 'hello'));
  });

  /* ---------------- prompt ---------------- */
  await test('prompt: bot name, placeholders, pitch only for own company, formats', async () => {
    const props = [{ projectName: 'Omega Heights', city: 'Kanpur', images: ['a'], brochureUrl: null }];
    const client = promptBuilder.buildSystemInstruction({ lead, matchedProperties: props, botName: 'Priya', botGender: 'male', pitchAllowed: false });
    assert.ok(/You are Priya/.test(client));
    assert.ok(!/Monica/.test(client), 'no Monica in a client bot');
    assert.ok(!/8750200899/.test(client), 'no platform number in a client bot');
    assert.ok(!/Ivory|Sunflower|Palorma|Noida/.test(client), 'no real-looking example projects');
    assert.ok(/masculine verbs/.test(client));
    assert.ok(/WHATSAPP LIST FORMAT/.test(client));
    assert.ok(/Devanagari/.test(client));
    assert.ok(/Photos uploaded: 1/.test(client) && /Brochure: not uploaded/.test(client));
    assert.ok(/SALES APPROACH/.test(client));
    const own = promptBuilder.buildSystemInstruction({ lead, botName: 'Monica', pitchAllowed: true });
    assert.ok(/8750200899/.test(own), 'own company keeps its pitch');
  });

  await test('client instructions + language lock reach the model', async () => {
    reset();
    state.recent = [{ _id: 'b1', direction: 'inbound', type: 'text', text: 'price?' }];
    state.geminiReply = baseReply('Ji');
    await engine.handleInbound({ conversation: makeConversation({ language: 'Hindi' }), lead, message: { _id: 'b1', type: 'text', text: 'price?' } });
    const sys = geminiPrompts[0].systemInstruction;
    assert.ok(sys.includes('COMPANY INSTRUCTIONS') && sys.includes('Highlight the metro.'));
    assert.ok(/LANGUAGE LOCK — the customer chose Hindi\. Write the ENTIRE reply in simple Hindi using Devanagari/.test(sys));
  });

  /* ---------------- media ---------------- */
  const omega = { _id: 'P1', projectName: 'Omega Heights', images: ['1', '2', '3', '4', '5', '6', '7'], brochureUrl: 'https://x/b.pdf', isActive: true };
  await test('details reply that offers photos/brochure → offer remembered (only what exists)', async () => {
    reset();
    state.props = [omega];
    state.recent = [{ _id: 'c1', direction: 'inbound', type: 'text', text: 'Omega Heights ki details' }];
    state.geminiReply = baseReply('*Omega Heights*\n• Price: ₹85 L\n\nPhotos ya brochure bhejun?', { property_reference: 'Omega Heights' });
    const conv = makeConversation();
    await engine.handleInbound({ conversation: conv, lead, message: { _id: 'c1', type: 'text', text: 'Omega Heights ki details' } });
    const sys = geminiPrompts[0].systemInstruction;
    assert.ok(sys.includes('MEDIA for "Omega Heights": photos and a brochure are uploaded'));
    assert.strictEqual(String(conv.currentPropertyId), 'P1');
    assert.strictEqual(conv.mediaOffer.kind, 'both');
    assert.strictEqual(sent.images.length, 0, 'nothing sent before the customer agrees');
    state.offerConv = conv;
  });

  await test('"haan" → that property\'s photos (max 5) + brochure', async () => {
    reset();
    state.recent = [
      { _id: 'c1b', direction: 'outbound', text: '*Omega Heights*\n• Price: ₹85 L\n\nPhotos ya brochure bhejun?' },
      { _id: 'c2', direction: 'inbound', type: 'text', text: 'haan ji, bhejo' },
    ];
    state.geminiReply = baseReply('Ji, bhej rahi hoon 😊');
    const conv = state.offerConv;
    await engine.handleInbound({ conversation: conv, lead, message: { _id: 'c2', type: 'text', text: 'haan ji, bhejo' } });
    assert.strictEqual(sent.images.length, 5, 'max 5 photos');
    assert.strictEqual(sent.docs.length, 1);
    assert.strictEqual(conv.mediaOffer.kind, null, 'offer used up');
  });

  await test('"haan" to a later question does not send old photos', async () => {
    reset();
    const conv = makeConversation({ currentPropertyId: 'P1', mediaOffer: { propertyId: 'P1', kind: 'both', at: new Date() } });
    state.props = [omega];
    state.recent = [
      { _id: 'e1', direction: 'outbound', text: 'Kya aap iski site visit karna chahenge?' },
      { _id: 'e2', direction: 'inbound', type: 'text', text: 'haan' },
    ];
    state.geminiReply = baseReply('Badhiya! Kaunsa din theek rahega?');
    await engine.handleInbound({ conversation: conv, lead, message: { _id: 'e2', type: 'text', text: 'haan' } });
    assert.strictEqual(sent.images.length, 0);
    assert.strictEqual(sent.docs.length, 0);
  });

  await test('property without media → AI told never to offer; "document" alone is not a brochure request', async () => {
    reset();
    const bare = { _id: 'P2', projectName: 'Bare Park', images: [], brochureUrl: null, isActive: true };
    state.props = [bare];
    state.recent = [{ _id: 'd1', direction: 'inbound', type: 'text', text: 'loan ke liye document chahiye' }];
    state.geminiReply = baseReply('Team aapko guide karegi.');
    await engine.handleInbound({ conversation: makeConversation({ currentPropertyId: 'P2' }), lead, message: { _id: 'd1', type: 'text', text: 'loan ke liye document chahiye' } });
    assert.ok(geminiPrompts[0].systemInstruction.includes('MEDIA for "Bare Park": NO photos or brochure uploaded'));
    assert.strictEqual(sent.docs.length, 0);
  });

  /* ---------------- calling policy ---------------- */
  await test('calls: region, UAE off, STOP, DND, friendly errors', async () => {
    assert.strictEqual(policy.regionForPhone('+971501234567'), 'AE');
    assert.strictEqual(policy.regionForPhone('9876543210'), 'IN');
    const uae = await policy.canCall({ _id: 'x', phone: '971501234567' }, { settings: settingsObj });
    assert.ok(!uae.ok && /UAE/.test(uae.reason));
    const stop = await policy.canCall({ _id: 'x', phone: '919800000000', optedOut: true }, { settings: settingsObj });
    assert.ok(!stop.ok && /STOP/.test(stop.reason));
    const axios = require('axios');
    const realGet = axios.get;
    axios.get = async () => ({ data: { status: 'DND - Fully Blocked' } });
    const dnd = await policy.canCall({ _id: 'x', phone: '919800000000' }, { settings: { ...settingsObj, calling: { dnd: { enabled: true, apiUrl: 'https://d/check?n={phone}' } } } });
    axios.get = realGet;
    assert.ok(!dnd.ok && /DND/.test(dnd.reason));
    assert.strictEqual(policy.friendlyCallError({ status: 'failed', hangupCause: 'UNALLOCATED_NUMBER' }), 'Wrong / invalid number');
    assert.strictEqual(policy.friendlyCallError({ error: 'Insufficient balance' }), 'Plivo balance finished — recharge the calling account');
    // E5: the call follows the customer's saved chat language (not the region).
    assert.strictEqual(policy.callLanguage('AE', 'Hindi'), 'hi');
    assert.strictEqual(policy.callLanguage('IN', 'Hinglish'), 'hi');
    assert.strictEqual(policy.callLanguage('AE', 'Arabic'), 'ar');
    assert.strictEqual(policy.callLanguage('AE', null), 'en', 'no saved language → region default');
    assert.strictEqual(policy.callLanguage('IN', 'Tamil'), null, 'Tamil not enabled for calls → no call in another language');
  });

  /* ---------------- after a lead call ---------------- */
  const CallLog = R('models/CallLog');
  const voice = R('services/voice/voiceService');
  const FollowUp = R('models/FollowUp');
  FollowUp.findOneAndUpdate = async () => ({});
  FollowUp.updateMany = async () => ({});
  CallLog.updateOne = async () => ({});
  CallLog.findOneAndUpdate = async () => ({});
  Conversation.findOne = (q) => {
    const conv = { _id: 'C1', ownerId: 'O1', leadId: 'L1', lastInboundAt: new Date(), language: 'Hinglish', templateSent: true };
    const p = Promise.resolve(conv);
    p.select = () => ({ lean: async () => conv });
    p.lean = async () => conv;
    return p;
  };
  const leadRow = { _id: 'L1', ownerId: 'O1', name: 'Ravi', phone: '919800000000', aiCall: { retries: 0 } };
  Lead.findById = async () => ({ ...leadRow, save: async () => {} });

  await test('"busy, call later" on a lead call → AI calls again + WhatsApp note', async () => {
    reset();
    await voice.applyOutcome({ _id: 'CL1', leadId: 'L1', purpose: 'enquiry', trigger: 'bulk', extracted: { callback_later: true, visit: 'unknown' } });
    const q = state.leadUpdates.find((u) => u.$set?.['aiCall.status'] === 'queued');
    assert.ok(q, 'lead queued again');
    assert.strictEqual(q.$set['aiCall.reason'], 'callback');
    assert.ok(q.$set['aiCall.nextCallAt'] > new Date(), 'call-back is in the future');
    assert.ok(sent.text.some((t) => /call karenge/.test(t)), 'WhatsApp note sent');
  });

  await test('call not picked up → retry in 2–3 h; still not reached → WhatsApp', async () => {
    reset();
    CallLog.findById = () => ({ select: () => ({ lean: async () => ({ status: 'no-answer', hangupCause: 'No Answer', turns: [], extracted: {} }) }) });
    await voice.afterLeadCall({ _id: 'CL2', leadId: 'L1', purpose: 'enquiry', trigger: 'bulk' }, { answered: false });
    const retry = state.leadUpdates.find((u) => u.$set?.['aiCall.reason'] === 'retry');
    assert.ok(retry, 'retry queued');
    const hrs = (retry.$set['aiCall.nextCallAt'] - Date.now()) / 3600e3;
    assert.ok(hrs >= 1.9, `retry at least ~2h later (got ${hrs.toFixed(2)}h)`);
    reset();
    Lead.findById = async () => ({ ...leadRow, aiCall: { retries: 1 }, save: async () => {} });
    await voice.afterLeadCall({ _id: 'CL3', leadId: 'L1', purpose: 'enquiry', trigger: 'bulk' }, { answered: false });
    assert.ok(!state.leadUpdates.some((u) => u.$set?.['aiCall.reason'] === 'retry'), 'no second retry');
    assert.ok(sent.text.some((t) => /call kiya tha/.test(t)), 'WhatsApp bot starts the chat');
  });

  await test('wrong number → no retry, no WhatsApp', async () => {
    reset();
    Lead.findById = async () => ({ ...leadRow, save: async () => {} });
    CallLog.findById = () => ({ select: () => ({ lean: async () => ({ status: 'failed', hangupCause: 'UNALLOCATED_NUMBER', turns: [], extracted: {} }) }) });
    await voice.afterLeadCall({ _id: 'CL4', leadId: 'L1', purpose: 'enquiry', trigger: 'bulk' }, { answered: false });
    assert.strictEqual(state.leadUpdates.length, 0);
    assert.strictEqual(sent.text.length, 0);
  });

  await test('interested on the call, no visit → WhatsApp bot approaches with the summary', async () => {
    reset();
    CallLog.findById = () => ({ select: () => ({ lean: async () => ({ status: 'completed', outcome: 'follow_up', summary: 'Wants 2BHK near metro, budget 80L', turns: [{ role: 'customer', text: 'haan' }], extracted: { interested: true } }) }) });
    R('services/ai/geminiClient').generateContent = async () => ({ text: 'Hi Ravi! Metro ke paas 2BHK ke liye site visit kab rakhein?' });
    await voice.afterLeadCall({ _id: 'CL5', leadId: 'L1', purpose: 'enquiry', trigger: 'bulk' }, { answered: true });
    assert.ok(sent.text.some((t) => /site visit kab/.test(t)));
    assert.ok(state.convUpdates.some((u) => u.$set?.lastCallSummary === 'Wants 2BHK near metro, budget 80L'), 'summary saved for the chat AI');
  });

  console.log(`\n${passed} passed${process.exitCode ? ' (with failures)' : ''}`);
  process.exit(process.exitCode || 0);
})();
