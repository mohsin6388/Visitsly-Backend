/* eslint-disable no-console */
/**
 * Smoke test (no database) for spec section E — conversation language:
 *   E0 ask once in English when the first message is English
 *   E1 first message in another language → reply in it, no question
 *   E2 chosen language locked     E3 explicit change request
 *   E4 switch only after two real messages in another language
 *   E5 backend messages (visit confirmation, follow-ups, calls) in the saved language
 *   node test/language.smoke.js
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

const L = R('services/language');
const { MESSAGES } = R('services/language/messages');

/* ------------------------------------------------------------------ */
/* Stubs for the chat engine                                           */
/* ------------------------------------------------------------------ */
const sent = { text: [], buttons: [], templates: [] };
const state = { newer: false, recent: [], geminiReply: null, convUpdates: [] };
const settingsObj = {
  autoReplyEnabled: true, aiPaused: false, whatsappDisconnected: false,
  assistant: { name: 'Priya', gender: 'female' }, referral: { enabled: false },
  visitConfirm: { callEnabled: false, templateName: 'visit_confirm', templateLanguage: 'en_US', templateVariableCount: 4 },
  followUp: { templateName: '', messages: [] }, companyName: 'ABC Realty',
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
Conversation.updateOne = async (q, u) => { state.convUpdates.push({ q, u }); return { modifiedCount: 1 }; };
Conversation.findById = () => ({ select: () => ({ lean: async () => ({ aiReplyCount: 0 }) }) });
Conversation.findOneAndUpdate = () => ({ select: () => ({ lean: async () => ({ aiReplyCount: 1 }) }) });
const Meeting = R('models/Meeting');
Meeting.findOne = () => ({ sort: () => ({ populate: () => ({ lean: () => Promise.resolve(null) }) }) });
Meeting.exists = async () => false;
R('models/Lead').updateOne = async () => ({});

const wa = R('services/whatsapp/metaWhatsappClient');
wa.sendToLead = async ({ text }) => { sent.text.push(text); return { messageId: `m${sent.text.length}` }; };
wa.sendTextMessage = async ({ text }) => { sent.text.push(text); return { messageId: 't' }; };
wa.sendButtonsMessage = async ({ text, buttons }) => { sent.text.push(text); sent.buttons.push(buttons); return { messageId: 'b' }; };
R('services/whatsapp/messageStore').recordOutboundMessage = async (m) => ({ _id: 'out', ...m });
R('services/ai/propertyMatcher').matchProperties = async () => [];
R('services/sites/siteBrochure').attachSiteBrochure = async (p) => p;
R('services/ai/leadAnalyzer').analyzeConversationAsync = async () => {};
R('sockets').emitToUser = () => {};
let geminiPrompts = [];
R('services/ai/geminiClient').generateStructured = async ({ systemInstruction }) => {
  if (state.geminiFail) throw new Error('503 all models busy');
  geminiPrompts.push(systemInstruction);
  return { parsed: state.geminiReply, raw: '{}' };
};
R('services/ai/geminiClient').generateContent = async ({ history }) => ({ text: `[translated] ${history[0].text}` });

const engine = R('services/ai/conversationEngine');

const reply = (text, extra = {}) => ({
  reply: text, name: null, phone: null, preferred_language: null, language_change_request: null, property_type: null, budget: null,
  location_preference: null, purpose: null, timeline: null, interest_level: 'pata nahi', verified: false, notes: null, lead_type: 'buyer',
  assistant_interest: 'pata nahi', send_property_media: false, property_reference: null,
  extractedRequirements: { projectName: null, city: null, location: null, budgetMin: null, budgetMax: null, bhk: null, propertyType: null, amenities: [] },
  ...extra,
});
const conv = (extra = {}) => ({
  _id: 'C1', ownerId: 'O1', status: 'ai_active', collectedRequirements: {}, recommendedProperties: [], language: null, languageSource: null,
  languagePromptedAt: null, languagePromptAnsweredAt: null, referralStatus: 'none', mediaOffer: { propertyId: null, kind: null, at: null },
  async save() { return this; }, ...extra,
});
const lead = { _id: 'L1', ownerId: 'O1', name: 'Ravi', phone: '919800000000' };
const reset = () => { sent.text = []; sent.buttons = []; sent.templates = []; state.convUpdates = []; geminiPrompts = []; state.newer = false; };
const savedSet = () => Object.assign({}, ...state.convUpdates.map((x) => x.u.$set || {}));
const inbound = (id, text) => ({ _id: id, direction: 'inbound', type: 'text', text });

(async () => {
  console.log('language smoke test');

  /* ---------------- catalog ---------------- */
  await test('E5 catalog: every message in all 13 languages, same placeholders, buttons ≤ 20 chars', () => {
    const keys = Object.keys(MESSAGES.English);
    assert.strictEqual(L.NAMES.length, 13);
    const ph = (s) => [...new Set(s.match(/\{\w+\}/g) || [])].sort().join();
    for (const name of L.NAMES) {
      assert.ok(MESSAGES[name], `missing language ${name}`);
      for (const k of keys) {
        assert.ok(MESSAGES[name][k], `${name} is missing ${k}`);
        assert.strictEqual(ph(MESSAGES[name][k]), ph(MESSAGES.English[k]), `${name} ${k} placeholders`);
      }
      assert.ok(MESSAGES[name]['visit.btnYes'].length <= 20 && MESSAGES[name]['visit.btnNo'].length <= 20, `${name} button too long`);
    }
    assert.strictEqual(L.LANGUAGE_QUESTION, 'Which language would you prefer to chat in?');
  });

  /* ---------------- detection ---------------- */
  await test('detection: scripts, Hindi vs Hinglish vs Marathi, Urdu vs Arabic', () => {
    const d = (t) => L.detectLanguage(t).language;
    assert.strictEqual(d('Hello, I am looking for a 2BHK in Pune'), 'English');
    assert.strictEqual(d('Mujhe 2BHK chahiye Noida mein'), 'Hinglish');
    assert.strictEqual(d('मुझे 2 BHK flat चाहिए'), 'Hindi');
    assert.strictEqual(d('मला 2 BHK फ्लॅट पाहिजे आहे'), 'Marathi');
    assert.strictEqual(d('مجھے ایک فلیٹ چاہیے'), 'Urdu');
    assert.strictEqual(d('أريد شقة في دبي'), 'Arabic');
    assert.strictEqual(d('আমি একটি ফ্ল্যাট চাই'), 'Bangla');
    assert.strictEqual(d('எனக்கு ஒரு வீடு வேண்டும்'), 'Tamil');
    assert.strictEqual(d('నాకు ఒక ఇల్లు కావాలి'), 'Telugu');
    assert.strictEqual(d('ನನಗೆ ಮನೆ ಬೇಕು'), 'Kannada');
    assert.strictEqual(d('എനിക്ക് ഒരു വീട് വേണം'), 'Malayalam');
    assert.strictEqual(d('મને ફ્લેટ જોઈએ છે'), 'Gujarati');
    assert.strictEqual(d('ਮੈਨੂੰ ਫਲੈਟ ਚਾਹੀਦਾ ਹੈ'), 'Punjabi');
    assert.strictEqual(d('ami ekta flat chai'), null, 'romanised Bangla is not taken for English');
    assert.ok(L.detectLanguage('ok').neutral && L.detectLanguage('thanks').neutral && L.detectLanguage('👍').neutral);
  });

  await test('E3 explicit requests (spec examples + native scripts), negations ignored', () => {
    const r = (t) => L.parseLanguageRequest(t);
    assert.strictEqual(r('Hindi mein baat karo'), 'Hindi');
    assert.strictEqual(r('Speak in English'), 'English');
    assert.strictEqual(r('Urdu mein jawab do'), 'Urdu');
    assert.strictEqual(r('hinglish me baat karo'), 'Hinglish');
    assert.strictEqual(r('Tamil'), 'Tamil');
    assert.strictEqual(r('தமிழில் பேசுங்கள்'), 'Tamil');
    assert.strictEqual(r('اردو میں بات کریں'), 'Urdu');
    assert.strictEqual(r('বাংলায় কথা বলুন'), 'Bangla');
    assert.strictEqual(r('I need 3bhk in Pune, please reply in Hindi'), 'Hindi');
    assert.strictEqual(r('Hindi nahi aati, English mein bolo'), 'English');
    // Regional requests typed in Roman letters
    assert.strictEqual(r('Marathi madhe bola'), 'Marathi');
    assert.strictEqual(r('Gujarati ma vaat karo'), 'Gujarati');
    assert.strictEqual(r('Punjabi vich gal karo'), 'Punjabi');
    assert.strictEqual(r('Bangla te kotha bolun'), 'Bangla');
    assert.strictEqual(r('Tamil la pesunga'), 'Tamil');
    assert.strictEqual(r('Telugu lo matladandi'), 'Telugu');
    assert.strictEqual(r('Kannada dalli maatadi'), 'Kannada');
    assert.strictEqual(r('Malayalam il samsarikkuka'), 'Malayalam');
    assert.strictEqual(r("I don't understand Hindi"), null);
    assert.strictEqual(r('Is the brochure available in Hindi?'), null);
    assert.strictEqual(r('Hindi or English, both ok'), null);
  });

  /* ---------------- rules (pure) ---------------- */
  const decide = L.decideLanguage;
  await test('E0: first message English / unreadable → ask once; E1: other language → no question', () => {
    assert.deepStrictEqual([decide({ batch: ['Hi'], firstTurn: true }).ask, decide({ batch: ['Hi'], firstTurn: true }).language], [true, 'English']);
    assert.strictEqual(decide({ batch: ['👍'], firstTurn: true }).ask, true);
    const hi = decide({ batch: ['मुझे 2 BHK चाहिए'], firstTurn: true });
    assert.deepStrictEqual([hi.ask, hi.language, hi.source], [false, 'Hindi', 'detected']);
    assert.strictEqual(decide({ batch: ['Mujhe flat chahiye'], firstTurn: true }).language, 'Hinglish');
    assert.strictEqual(decide({ batch: ['வணக்கம்'], firstTurn: true }).language, 'Tamil');
    // never twice, never later in the chat
    assert.strictEqual(decide({ saved: { language: 'English', source: 'detected', promptedAt: new Date(), promptAnsweredAt: new Date() }, batch: ['Hello again'], inbound: ['Hello again'], firstTurn: false }).ask, false);
    assert.strictEqual(decide({ saved: {}, batch: ['Hello'], inbound: ['earlier', 'Hello'], firstTurn: false }).ask, false);
    // "Hindi mein baat karo" as a first message is a choice, not a reason to ask
    const first = decide({ batch: ['Hi, Hindi mein baat karo'], firstTurn: true });
    assert.deepStrictEqual([first.ask, first.language, first.source], [false, 'Hindi', 'selected']);
  });

  const pending = { language: 'English', source: 'detected', promptedAt: new Date(), promptAnsweredAt: null };
  await test('answer to the language question: name → locked, other language → used, "ok" → nothing', () => {
    const a = decide({ saved: pending, batch: ['Hindi'], inbound: ['Hi', 'Hindi'] });
    assert.deepStrictEqual([a.language, a.source, a.promptAnswered], ['Hindi', 'selected', true]);
    const b = decide({ saved: pending, batch: ['எனக்கு ஒரு வீடு வேண்டும்'], inbound: ['Hi', 'எனக்கு ஒரு வீடு வேண்டும்'] });
    assert.deepStrictEqual([b.language, b.promptAnswered], ['Tamil', true]);
    const c = decide({ saved: pending, batch: ['ok'], inbound: ['Hi', 'ok'] });
    assert.deepStrictEqual([c.changed, c.ask, c.promptAnswered], [false, false, false]);
    const hinglish = decide({ saved: pending, batch: ['Hinglish'], inbound: ['Hi', 'Hinglish'] });
    assert.strictEqual(hinglish.language, 'Hinglish', 'Hinglish and Hindi are separate');
  });

  await test('E2 / E3: chosen language locked; explicit request switches immediately', () => {
    const locked = { language: 'Hindi', source: 'selected', promptedAt: new Date(), promptAnsweredAt: new Date() };
    const two = decide({ saved: locked, batch: ['I want a 3 BHK flat'], inbound: ['Can you share the price list', 'I want a 3 BHK flat'] });
    assert.strictEqual(two.changed, false, 'messages in another language never override a chosen language');
    const sw = decide({ saved: locked, batch: ['Speak in English'], inbound: ['Speak in English'] });
    assert.deepStrictEqual([sw.language, sw.source, sw.changed], ['English', 'selected', true]);
    const old = decide({ saved: { language: 'Hinglish' }, batch: ['I want a 3 BHK flat'], inbound: ['Can you share the price list', 'I want a 3 BHK flat'] });
    assert.strictEqual(old.changed, false, 'old chats (no source) stay locked');
  });

  await test('E4: two consecutive real messages switch; one message / ok / thanks / emoji never do', () => {
    const det = { language: 'English', source: 'detected', promptedAt: new Date(), promptAnsweredAt: new Date() };
    assert.strictEqual(decide({ saved: det, batch: ['Mujhe flat chahiye'], inbound: ['I need a flat', 'Mujhe flat chahiye'] }).changed, false);
    const two = decide({ saved: det, batch: ['Pune mein chahiye'], inbound: ['Mujhe 2 BHK chahiye', 'Pune mein chahiye'] });
    assert.deepStrictEqual([two.language, two.reason], ['Hinglish', 'auto_switch']);
    assert.strictEqual(decide({ saved: det, batch: ['haan'], inbound: ['haan', 'theek hai'] }).changed, false, 'short acks never switch');
    assert.strictEqual(decide({ saved: det, batch: ['👍'], inbound: ['Mujhe 2 BHK chahiye', '👍'] }).changed, false);
    const toHindi = decide({ saved: { language: 'Hinglish', source: 'detected' }, batch: ['पुणे में चाहिए'], inbound: ['मुझे 2 BHK चाहिए', 'पुणे में चाहिए'] });
    assert.strictEqual(toHindi.language, 'Hindi', 'Devanagari Hindi is not Hinglish');
  });

  /* ---------------- chat engine ---------------- */
  await test('engine E0: first "Hi" → the English question goes out once, no AI reply', async () => {
    reset();
    state.recent = [inbound('a1', 'Hi')];
    state.geminiReply = reply('should not be sent');
    const c = conv();
    await engine.handleInbound({ conversation: c, lead, message: { _id: 'a1', type: 'text', text: 'Hi' } });
    assert.strictEqual(sent.text.length, 1);
    assert.ok(sent.text[0].includes('Which language would you prefer to chat in?'));
    assert.ok(/हिंदी \(Hindi\)/.test(sent.text[0]) && /العربية \(Arabic\)/.test(sent.text[0]));
    assert.strictEqual(geminiPrompts.length, 0, 'no model call for the question');
    assert.ok(state.convUpdates.some((x) => x.u.$set?.languagePromptedAt), 'question claimed once');
    assert.strictEqual(c.language, 'English');
  });

  await test('engine: a newer message is waiting → this run neither asks nor replies', async () => {
    reset();
    state.newer = true;
    state.recent = [inbound('a1', 'Hi'), inbound('a2', 'I need a flat')];
    await engine.handleInbound({ conversation: conv(), lead, message: { _id: 'a1', type: 'text', text: 'Hi' } });
    assert.strictEqual(sent.text.length, 0);
  });

  await test('engine: reply "Hindi" → locked Hindi, model told to answer in Devanagari', async () => {
    reset();
    const q = 'Hi! I\'m Priya…\nWhich language would you prefer to chat in?';
    state.recent = [inbound('a1', 'Hi, I need a 2BHK'), { _id: 'q', direction: 'outbound', text: q }, inbound('a2', 'Hindi')];
    state.geminiReply = reply('जी, बताइए — आपका बजट कितना है?');
    const c = conv({ language: 'English', languageSource: 'detected', languagePromptedAt: new Date() });
    await engine.handleInbound({ conversation: c, lead, message: { _id: 'a2', type: 'text', text: 'Hindi' } });
    assert.strictEqual(c.language, 'Hindi');
    assert.strictEqual(c.languageSource, 'selected');
    const sys = geminiPrompts[0];
    assert.ok(/LANGUAGE LOCK — the customer chose Hindi\. Write the ENTIRE reply in simple Hindi using Devanagari/.test(sys));
    assert.ok(/LANGUAGE JUST CHOSEN/.test(sys));
    assert.ok(!sent.text.some((t) => t.includes('Which language')), 'never asked again');
  });

  await test('engine E1: first message in Tamil → no question, Tamil rule', async () => {
    reset();
    state.recent = [inbound('t1', 'எனக்கு சென்னையில் ஒரு வீடு வேண்டும்')];
    state.geminiReply = reply('சரி! உங்கள் பட்ஜெட் என்ன?');
    const c = conv();
    await engine.handleInbound({ conversation: c, lead, message: { _id: 't1', type: 'text', text: 'எனக்கு சென்னையில் ஒரு வீடு வேண்டும்' } });
    assert.strictEqual(sent.text.length, 1);
    assert.ok(!sent.text[0].includes('Which language'));
    assert.strictEqual(c.language, 'Tamil');
    assert.ok(/Tamil script/.test(geminiPrompts[0]));
  });

  await test('engine: model reports an explicit switch the rules missed → saved only if the customer named it', async () => {
    reset();
    state.recent = [{ _id: 'o', direction: 'outbound', text: 'Hello!' }, inbound('x1', 'can we continue in telugu from now')];
    state.geminiReply = reply('తప్పకుండా!', { language_change_request: 'Telugu' });
    const c = conv({ language: 'English', languageSource: 'detected' });
    await engine.handleInbound({ conversation: c, lead, message: { _id: 'x1', type: 'text', text: 'can we continue in telugu from now' } });
    assert.strictEqual(c.language, 'Telugu');
    reset();
    state.recent = [{ _id: 'o', direction: 'outbound', text: 'Hello!' }, inbound('x2', 'what is the price')];
    state.geminiReply = reply('It is 80 L.', { language_change_request: 'Telugu' });
    const c2 = conv({ language: 'English', languageSource: 'detected' });
    await engine.handleInbound({ conversation: c2, lead, message: { _id: 'x2', type: 'text', text: 'what is the price' } });
    assert.strictEqual(c2.language, 'English', 'a made-up switch is ignored');
  });

  await test('engine: AI down → hold message in the saved language', async () => {
    reset();
    state.geminiFail = true;
    state.recent = [{ _id: 'o', direction: 'outbound', text: 'নমস্কার' }, inbound('b1', 'দাম কত?')];
    await engine.handleInbound({ conversation: conv({ _id: 'C9', language: 'Bangla', languageSource: 'selected' }), lead, message: { _id: 'b1', type: 'text', text: 'দাম কত?' } });
    state.geminiFail = false;
    assert.strictEqual(sent.text[0], MESSAGES.Bangla['ai.hold']);
  });

  /* ---------------- Site visit booking in every language ---------------- */
  await test('visit: day + time understood in all 13 languages; "no" / no day never books', () => {
    const vi = R('services/ai/visitInference');
    const tomorrow = L.istDay(1);
    const ask = (bot, said) => vi.inferVisitFromChat({ recentMessages: [{ direction: 'outbound', text: bot }], currentMessage: said });
    const cases = [
      ['Kaunsa din aur time aapke liye theek rahega?', 'kal shaam 7 baje', '19:00'],
      ['कौन सा दिन और समय आपके लिए ठीक रहेगा?', 'कल शाम 5 बजे', '17:00'],
      ['آپ کے لیے کون سا دن اور وقت ٹھیک رہے گا؟', 'کل شام 5 بجے', '17:00'],
      ['أي يوم ووقت يناسبك؟', 'بكرة الساعة 5 مساء', '17:00'],
      ['আপনার জন্য কোন দিন এবং সময় ভালো হবে?', 'কাল সকাল ১১টায়', '11:00'],
      ['तुमच्यासाठी कोणता दिवस आणि वेळ सोयीचा आहे?', 'उद्या सकाळी 11 वाजता', '11:00'],
      ['તમારા માટે કયો દિવસ અને સમય યોગ્ય રહેશે?', 'કાલે સાંજે 5 વાગ્યે', '17:00'],
      ['ਤੁਹਾਡੇ ਲਈ ਕਿਹੜਾ ਦਿਨ ਅਤੇ ਸਮਾਂ ਠੀਕ ਰਹੇਗਾ?', 'ਕੱਲ੍ਹ ਸਵੇਰੇ 11 ਵਜੇ', '11:00'],
      ['உங்களுக்கு எந்த நாள் மற்றும் நேரம் வசதியாக இருக்கும்?', 'நாளை காலை 11 மணிக்கு', '11:00'],
      ['మీకు ఏ రోజు, ఏ సమయం అనుకూలంగా ఉంటుంది?', 'రేపు సాయంత్రం 5 గంటలకు', '17:00'],
      ['ನಿಮಗೆ ಯಾವ ದಿನ ಮತ್ತು ಸಮಯ ಅನುಕೂಲ?', 'ನಾಳೆ ಬೆಳಿಗ್ಗೆ 11 ಗಂಟೆಗೆ', '11:00'],
      ['നിങ്ങൾക്ക് ഏത് ദിവസവും സമയവുമാണ് സൗകര്യം?', 'നാളെ രാവിലെ 11 മണിക്ക്', '11:00'],
      ['Which day and time works for you?', 'tomorrow 4:30 pm', '16:30'],
    ];
    for (const [bot, said, time] of cases) {
      assert.deepStrictEqual(ask(bot, said) && { date: ask(bot, said).date, time: ask(bot, said).time }, { date: tomorrow, time }, said);
    }
    // The customer asks for a visit on a day themselves, no question before.
    assert.strictEqual(ask('ok', 'நாளை சைட் விசிட் வேண்டும்')?.date, tomorrow);
    assert.strictEqual(ask('ok', 'بدي زيارة للموقع بكرة العصر')?.time, '17:00');
    // Hindi tag "ना" is not a no.
    assert.strictEqual(ask('कौन सा दिन और समय ठीक रहेगा?', 'कल आ जाऊंगा ना, दोपहर 2 बजे')?.time, '14:00');
    // Never book: a real no, no day, or a day word unrelated to a visit question.
    assert.strictEqual(ask('আপনার জন্য কোন দিন এবং সময় ভালো হবে?', 'আমি কাল আসব না'), null);
    assert.strictEqual(ask('أي يوم ووقت يناسبك؟', 'لا، مش الحين'), null);
    assert.strictEqual(ask('Kaunsa din aur time aapke liye theek rahega?', 'nahi abhi nahi, baad mein'), null);
    assert.strictEqual(ask('Kaunsa din aur time aapke liye theek rahega?', 'shaam 7 baje'), null);
    assert.strictEqual(ask('Which language would you prefer to chat in?', 'kal'), null);
  });

  await test('engine: Tamil chat, model forgets wantsSiteVisit → visit still saved for Site Visits + confirmation', async () => {
    reset();
    const created = [];
    const origFindOne = Meeting.findOne;
    const origCreate = Meeting.create;
    const none = () => { const q = { sort: () => q, populate: () => q, lean: () => Promise.resolve(null), select: () => q, then: (ok, ko) => Promise.resolve(null).then(ok, ko) }; return q; };
    Meeting.findOne = none;
    Meeting.create = async (doc) => { created.push(doc); return { _id: 'M1', ...doc, confirmation: { status: 'none' }, save: async () => {} }; };
    R('models/Notification').create = async () => ({});
    try {
      const q = 'உங்களுக்கு எந்த நாள் மற்றும் நேரம் வசதியாக இருக்கும்?';
      state.recent = [{ _id: 'o', direction: 'outbound', text: q }, inbound('t9', 'நாளை காலை 11 மணிக்கு')];
      state.geminiReply = reply('சரி, உங்கள் விசிட் நாளை காலை 11 மணிக்கு புக் செய்யப்பட்டது!'); // wantsSiteVisit missing
      const c = conv({ language: 'Tamil', languageSource: 'selected' });
      await engine.handleInbound({ conversation: c, lead, message: { _id: 't9', type: 'text', text: 'நாளை காலை 11 மணிக்கு' } });
      assert.strictEqual(created.length, 1, 'Meeting saved');
      assert.strictEqual(created[0].preferredDate, L.istDay(1));
      assert.strictEqual(created[0].preferredTime, '11:00');
      assert.strictEqual(created[0].dateTentative, false);
      assert.strictEqual(created[0].status, 'scheduled');
      assert.strictEqual(c.meetingStatus, 'scheduled');
    } finally {
      Meeting.findOne = origFindOne;
      Meeting.create = origCreate;
    }
  });

  /* ---------------- E5: backend messages ---------------- */
  await test('E5 visit confirmation: text + buttons in the saved language', () => {
    const vc = R('services/visits/visitConfirmation');
    const meeting = { preferredDate: L.istDay(1), preferredTime: '16:30', dateTentative: false };
    const ta = vc.buildText(lead, meeting, 'Omega Heights', { language: 'Tamil' });
    assert.ok(ta.startsWith('வணக்கம் Ravi!') && ta.includes('(Omega Heights)') && ta.includes('நாளை') && ta.includes('4:30 PM'));
    const hi = vc.buildText(lead, meeting, '', { language: 'Hindi' });
    assert.ok(/[ऀ-ॿ]/.test(hi) && hi.includes('कल'));
    const hg = vc.buildText(lead, meeting, '', { language: 'Hinglish' });
    assert.ok(hg.includes('kal') && !/[ऀ-ॿ]/.test(hg), 'Hinglish stays in Roman letters');
    const en = vc.buildText(lead, { ...meeting, dateTentative: true }, 'Omega', { language: 'English' });
    assert.ok(en.includes('Which day and time'));
  });

  await test('E5 visit confirmation reply: tapped button id or a yes/no in any language', async () => {
    const vc = R('services/visits/visitConfirmation');
    const makeMeeting = () => ({
      _id: 'M1', ownerId: 'O1', preferredDate: L.istDay(1), preferredTime: '11:00', dateTentative: false,
      confirmation: { status: 'pending' }, markModified() {}, async save() {},
    });
    let m = makeMeeting();
    Meeting.findOne = () => ({ sort: async () => m });
    R('models/Notification').create = async () => ({});
    reset();
    await vc.handleReply({ lead, conversation: conv({ language: 'Tamil' }), text: 'ஆம், உறுதி ✅', buttonId: 'visit_yes' });
    assert.strictEqual(m.confirmation.status, 'confirmed');
    assert.ok(sent.text[0].startsWith('நன்றி!'), 'acknowledged in Tamil');
    m = makeMeeting();
    reset();
    await vc.handleReply({ lead, conversation: conv({ language: 'Urdu' }), text: 'نہیں' });
    assert.strictEqual(m.confirmation.status, 'declined');
    assert.strictEqual(sent.text[0], MESSAGES.Urdu['visit.ackNo']);
    m = makeMeeting();
    reset();
    await vc.handleReply({ lead, conversation: conv({ language: 'Hindi' }), text: 'हाँ' });
    assert.strictEqual(m.confirmation.status, 'confirmed');
  });

  await test('E5 follow-ups: built-in text in the saved language; company text translated', async () => {
    const fu = R('services/followups/followUpAutomation');
    Conversation.findOne = () => ({ select: () => ({ lean: async () => ({ language: 'Gujarati' }) }) });
    const t1 = await fu.stepText({ cfg: { messages: [], reengage: {} }, lead, step: 1, conversation: { language: 'Gujarati' } });
    assert.strictEqual(t1, MESSAGES.Gujarati['followup.1'].replace('{name}', ' Ravi'));
    const t2 = await fu.stepText({ cfg: { messages: ['Hi {name}, new offers this week!'] }, lead, step: 1, conversation: { language: 'Gujarati' } });
    assert.strictEqual(t2, '[translated] Hi Ravi, new offers this week!');
  });

  await test('E5 templates: the approved translation in the customer\'s language, retry in the configured one', async () => {
    R('services/whatsapp/openingTemplateService').getTemplates = async () => [
      { name: 'visit_confirm', language: 'en_US', status: 'APPROVED' },
      { name: 'visit_confirm', language: 'ta', status: 'APPROVED' },
    ];
    const calls = [];
    wa.sendTemplateMessage = async ({ languageCode }) => { calls.push(languageCode); return { messageId: 'tpl' }; };
    const a = await L.sendTemplateInLanguage({ phone: '1', templateName: 'visit_confirm', configuredLanguage: 'en_US', language: 'Tamil', buildComponents: () => [] });
    assert.deepStrictEqual([a.languageCode, a.language], ['ta', 'Tamil']);
    const b = await L.sendTemplateInLanguage({ phone: '1', templateName: 'visit_confirm', configuredLanguage: 'en_US', language: 'Hinglish', buildComponents: () => [] });
    assert.strictEqual(b.languageCode, 'en_US', 'no Hinglish template → configured language');
    calls.length = 0;
    wa.sendTemplateMessage = async ({ languageCode }) => {
      calls.push(languageCode);
      if (languageCode === 'ta') { const e = new Error('Template not found'); e.code = 132001; throw e; }
      return { messageId: 'tpl' };
    };
    const c = await L.sendTemplateInLanguage({ phone: '1', templateName: 'visit_confirm', configuredLanguage: 'en_US', language: 'Tamil', buildComponents: (lng) => [{ lng }] });
    assert.deepStrictEqual(calls, ['ta', 'en_US']);
    assert.strictEqual(c.languageCode, 'en_US');
  });

  await test('E5 calls: saved language spoken when enabled, never another language', () => {
    const policy = R('services/voice/callPolicy');
    assert.deepStrictEqual(policy.callLanguageInfo('IN', 'Hinglish'), { code: 'hi', supported: true, saved: true, language: 'Hinglish' });
    assert.strictEqual(policy.callLanguageInfo('IN', 'Tamil').supported, false);
    process.env.VOICE_LANGUAGES = 'hi,en,ar,ta';
    assert.strictEqual(policy.callLanguage('IN', 'Tamil'), 'ta');
    delete process.env.VOICE_LANGUAGES;
    const va = R('config/voiceAgents');
    const ar = va.confirmationScript('ar', { name: 'Ravi', project: 'Omega', date: L.istDay(1), time: '11:00', company: 'Acme' });
    assert.ok(/[؀-ۿ]/.test(ar) && ar.includes('Omega'), 'Arabic opening (was English before)');
    const known = va.enquiryScript('hi', { name: 'Ravi', project: 'Omega', company: 'Acme', askLanguage: false });
    assert.ok(!/Hindi में बात करना चाहेंगे या English/.test(known), 'a saved language is never asked again on the call');
    const unknown = va.enquiryScript('hi', { name: 'Ravi', project: 'Omega', company: 'Acme' });
    assert.ok(/Hindi में बात करना चाहेंगे या English/.test(unknown));
  });

  await test('dates and times in each language (Latin digits)', () => {
    const w = L.visitWhen({ preferredDate: L.istDay(1), preferredTime: '09:05' }, 'Hindi');
    assert.ok(w.day.startsWith('कल'));
    assert.strictEqual(L.timeLabel('16:30', 'English'), '4:30 PM');
    assert.ok(/^\d/.test(L.timeLabel('16:30', 'Marathi')), 'Latin digits');
    assert.strictEqual(L.relativeDay(L.istDay(0), 'Hinglish'), 'aaj');
  });

  console.log(`\n${passed} passed${process.exitCode ? ' (with failures)' : ''}`);
  process.exit(process.exitCode || 0);
})();
