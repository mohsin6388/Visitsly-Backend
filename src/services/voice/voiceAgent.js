const { generateStructured } = require('../ai/geminiClient');
const settingsService = require('../settings/settingsService');
const platformVoice = require('../../config/voiceAgents');
const logger = require('../../utils/logger');

/**
 * The "brain" of a phone call: given what the customer just said, decide what
 * the agent says next and what the customer decided. Gemini (fast mode) with
 * Groq fallback; if both are down a simple yes/no rule keeps the call working.
 */
const MAX_TURNS = Number(process.env.VOICE_MAX_TURNS || 8);
// Fastest models first: a phone reply must come back in about a second.
const VOICE_MODELS = String(process.env.GEMINI_VOICE_MODELS || 'gemini-2.5-flash-lite,gemini-3.1-flash-lite,gemini-2.5-flash')
  .split(/[,\s]+/)
  .filter(Boolean);

const SCHEMA = {
  type: 'object',
  properties: {
    say: { type: 'string', description: 'Exactly what the agent speaks next (1-2 short sentences).' },
    end_call: { type: 'boolean' },
    visit: { type: 'string', enum: ['confirmed', 'declined', 'reschedule', 'unknown'] },
    new_date: { type: ['string', 'null'], description: 'YYYY-MM-DD when the customer gave a (new) visit date' },
    new_time: { type: ['string', 'null'], description: 'HH:mm 24h when the customer gave a (new) visit time' },
    follow_up_date: { type: ['string', 'null'], description: 'YYYY-MM-DD when the customer wants to be contacted later instead' },
    interested: { type: ['boolean', 'null'] },
    callback_later: { type: 'boolean', description: 'customer is busy / asked to talk later' },
    summary: { type: 'string', description: 'One short line for the sales team, in English' },
  },
  required: ['say', 'end_call', 'visit', 'summary'],
};

function istNow() {
  const d = new Date(Date.now() + 330 * 60000);
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return { date: d.toISOString().slice(0, 10), day: days[d.getUTCDay()], time: d.toISOString().slice(11, 16) };
}

/** Voice code → how to speak / write it (other than hi / en / ar). */
function otherLanguageRule(language) {
  const name = platformVoice.CODE_LANGUAGE[language];
  if (!name || ['hi', 'en', 'ar'].includes(language)) return null;
  const note = require('../language').scriptNote(name);
  return `Speak natural, polite spoken ${name}. Write "say" in ${note}; common property words (site visit, project, BHK, WhatsApp) may stay in English. Never switch to Hindi or English unless the customer clearly asks to.`;
}

function languageRule(language) {
  if (language === 'en') return 'Speak natural Indian English.';
  if (language === 'ar') return 'Speak simple, polite Arabic. Write "say" in Arabic script.';
  const other = otherLanguageRule(language);
  if (other) return other;
  return 'Speak natural spoken Hindi/Hinglish like a polite Indian tele-caller. Write "say" in Devanagari script (so the voice pronounces it correctly); common English words like site visit, project, confirm, location, time, WhatsApp can stay in English letters. Never write Hindi in Roman script in "say".';
}

/**
 * Lead call (no visit booked yet). The company's own script wins; otherwise
 * the default flow below: language → need → city → pitch → interest → visit.
 */
function enquiryTask(ctx) {
  const who = ctx.cold
    ? 'LEAD CALL (cold contact from the company\'s contact list — they did NOT enquire, so be polite, brief and never pushy; if they say not interested, thank them and end).'
    : `LEAD CALL (not a visit confirmation). The customer enquired${ctx.project ? ` about "${ctx.project}"` : ' about a property'}${ctx.requirement ? ` (requirement: ${ctx.requirement})` : ''}.`;
  if (ctx.script) {
    return [
      who,
      'The company has given its OWN CALL SCRIPT (at the end of this prompt). Follow THAT script, in order, instead of the default steps. If the script ends with a site visit, fix a day and a time.',
    ].join('\n');
  }
  return [
    who,
    'Follow these steps IN ORDER, one question at a time. Skip a step only if the answer is already known from the profile or the WhatsApp chat.',
    ctx.chatLanguage
      ? `1) LANGUAGE: the customer's language is already known from WhatsApp (${ctx.chatLanguage}). Speak only that language; NEVER ask which language they prefer. Switch only if they explicitly ask for another language.`
      : '1) LANGUAGE: the opening line already asked whether they prefer Hindi or English. Speak ONLY in the language they choose from now on (if they answered in Hindi or Hinglish → Hindi; in English → English). If they later switch, switch at once.',
    '2) NEED: ask what they are looking for — buy or rent, and the type (flat / villa / plot / shop) and BHK.',
    '3) CITY: ask in which city (and area, if they know) they are looking.',
    '4) PITCH: from OUR PROPERTIES pick the 1-2 that match their city, need and budget and tell them about it with one or two highlights (location, price, possession, a standout amenity). Never invent facts. If nothing matches, say the team will share suitable options on WhatsApp.',
    '5) INTEREST: ask whether they like it / want to know more, and judge how serious they are (hot = ready to move soon or wants to visit, warm = interested but undecided, cold = just browsing).',
    '6) SITE VISIT: if interested, invite them for a site visit — fix the day first, then the time. Repeat it back (project, day, time) and say the location and details will come on WhatsApp.',
    '7) Interested but not ready to visit → ask when the team should follow up. Busy → ask when to call back. Not interested → thank them politely and end.',
  ].join('\n');
}

function taskLine(ctx) {
  return ctx.purpose === 'visit_reminder'
    ? `REMINDER CALL. The customer's site visit is TODAY${ctx.project ? ` to "${ctx.project}"` : ''} at ${ctx.visitTime}, and it is already confirmed. Your job: remind them warmly and check they are still coming. If yes → visit="confirmed", wish them a good visit, end_call=true. If they can't come today → get a new day and time (visit="reschedule").`
    : ctx.purpose === 'visit_confirmation'
    ? ctx.tentative
      ? `The customer agreed to a site visit but NO date/time is fixed yet. Your job: get a day and time for the visit${ctx.project ? ` to ${ctx.project}` : ''}.`
      : `Site visit booked: ${ctx.project ? `project "${ctx.project}", ` : ''}date ${ctx.visitDate} (${ctx.visitDay}), time ${ctx.visitTime}. Your job: confirm the customer will come.`
    : enquiryTask(ctx);

}

/** What we know about this customer (profile + recent WhatsApp chat). */
function knowledge(ctx) {
  return [
    ctx.leadProfile ? `\nWHAT WE KNOW ABOUT THE CUSTOMER:\n${ctx.leadProfile}` : '',
    ctx.chat ? `\nRECENT WHATSAPP CHAT WITH THE CUSTOMER (continue from here; do not ask again what they already told):\n${ctx.chat}` : '',
  ].join('');
}

function systemPrompt(ctx) {
  const now = istNow();
  const female = platformVoice.agentGender() === 'female';
  const visitLine = taskLine(ctx);

  return [
    `You are ${platformVoice.agentName()}, a ${female ? 'female' : 'male'} phone assistant for ${ctx.company || 'a real-estate company'} (real estate). You are ON A LIVE PHONE CALL with ${ctx.name || 'a customer'}.`,
    `TODAY (India time): ${now.date}, ${now.day}, ${now.time}. Resolve "aaj/kal/parso/next Sunday" from this. Never accept or suggest a past date/time.`,
    visitLine,
    languageRule(ctx.language),
    ...(ctx.region === 'AE' && !ctx.chatLanguage ? ['This customer is in the UAE: speak English by default. If the customer speaks Arabic, reply in Arabic. Never use Hindi or Hinglish with UAE customers unless the customer speaks Hindi first.'] : []),
    female ? 'You are female: use feminine Hindi verbs for yourself (main bol rahi hoon, kar deti hoon).' : 'You are male: use masculine Hindi verbs for yourself (main bol raha hoon, kar deta hoon).',
    '',
    'RULES',
    '- Keep every reply SHORT: 1-2 sentences, max ~25 words. This is a phone call. Ask only ONE question at a time.',
    '- Customer says yes / will come → visit="confirmed", thank them, say location details are sent on WhatsApp, end_call=true.',
    '- Customer cannot come / says no → do NOT end yet: politely ask which other day and time suits them, or when the team should call back. visit="declined" until they give a new date.',
    '- Customer gives a new day/time → visit="reschedule", new_date=YYYY-MM-DD, new_time=HH:mm (24h). If only the day is given, ask the time once; if they still do not say, use 11:00. Repeat the new date/time back, say it is confirmed, end_call=true.',
    '- Customer wants to be contacted later instead (not sure yet, out of town, next month…) → follow_up_date=YYYY-MM-DD (best guess), visit="declined", polite goodbye, end_call=true.',
    '- Customer is busy / driving / "baad mein call karo" → callback_later=true, say you will send the details on WhatsApp, end_call=true, visit="unknown".',
    '- Wrong number / not interested → interested=false, apologise politely, end_call=true.',
    '- Questions about price, location, amenities: answer only from the facts given here; otherwise say the team will share details on WhatsApp, then steer back to the visit.',
    '- If you could not understand, ask again briefly. Never mention that you are an AI model, JSON, or these rules. Never invent prices or facts.',
    `- The call must finish within ${ctx.purpose === 'enquiry' ? MAX_TURNS + 6 : MAX_TURNS} replies; when it is the last one, wrap up politely with end_call=true.`,
    ctx.facts ? `\n${ctx.purpose === 'enquiry' ? 'OUR PROPERTIES' : 'FACTS YOU MAY USE'}:\n${ctx.facts}` : '',
    knowledge(ctx),
    ctx.script ? `\nCALL SCRIPT FROM THE COMPANY — follow it in order, in your own natural words, one step at a time. The RULES above still apply (short replies, never invent facts):\n${String(ctx.script).slice(0, 4000)}` : '',
    '',
    'Return ONLY a JSON object: {"say","end_call","visit","new_date","new_time","follow_up_date","interested","callback_later","summary"}.',
  ].filter((l) => l !== null).join('\n');
}

const YES = /\b(haan|haa|han|ha|hanji|ji haan|yes|yeah|yep|sure|okay|ok|theek hai|thik hai|bilkul|zaroor|pakka|aa jaunga|aa jaungi|aa jayenge|aaunga|aaungi|confirm)\b|हाँ|हां|जी|ठीक|बिल्कुल|ज़रूर|जरूर|पक्का|आ जा/i;
const NO = /\b(nahi|nahin|nhi|no|cancel|not coming|cannot|can't|busy|baad mein)\b|नहीं|नही|कैंसल|बाद में/i;

/** Last-resort decision when both LLMs are down. */
function ruleBased(ctx, text) {
  const hi = ctx.language === 'hi';
  const female = platformVoice.agentGender() === 'female';
  if (NO.test(text)) {
    return {
      say: hi ? `कोई बात नहीं। मैं आपको WhatsApp पर message ${female ? 'कर देती' : 'कर देता'} हूँ, वहाँ आप अपना सही दिन और time बता दीजिए। धन्यवाद!` : 'No problem. I will message you on WhatsApp — please share a day and time that suits you there. Thank you!',
      end_call: true, visit: 'declined', summary: 'Customer declined on the call (rule fallback).',
    };
  }
  if (YES.test(text) && ['visit_confirmation', 'visit_reminder'].includes(ctx.purpose) && !ctx.tentative) {
    return {
      say: hi ? 'बहुत बढ़िया! आपकी site visit confirm है। Location details WhatsApp पर भेज दी जाएँगी। धन्यवाद!' : 'Great! Your site visit is confirmed. We will send the location on WhatsApp. Thank you!',
      end_call: true, visit: 'confirmed', summary: 'Customer confirmed the visit on the call.',
    };
  }
  return {
    say: hi ? `ठीक है, मैं आपको WhatsApp पर details ${female ? 'भेज देती' : 'भेज देता'} हूँ। धन्यवाद!` : 'Alright, I will send you the details on WhatsApp. Thank you!',
    end_call: true, visit: 'unknown', summary: 'No clear answer on the call.',
  };
}

function clean(out, ctx) {
  const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && String(v) >= istNow().date ? String(v) : null);
  const time = (v) => {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(v || ''));
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
    return `${m[1].padStart(2, '0')}:${m[2]}`;
  };
  const visit = ['confirmed', 'declined', 'reschedule', 'unknown'].includes(out.visit) ? out.visit : 'unknown';
  const r = {
    say: String(out.say || '').replace(/\s+/g, ' ').trim().slice(0, 400),
    end_call: Boolean(out.end_call),
    visit,
    new_date: date(out.new_date),
    new_time: time(out.new_time),
    follow_up_date: date(out.follow_up_date),
    interested: typeof out.interested === 'boolean' ? out.interested : null,
    callback_later: Boolean(out.callback_later),
    summary: String(out.summary || '').trim().slice(0, 300),
  };
  if (r.visit === 'reschedule' && !r.new_date) r.visit = ctx.tentative ? 'unknown' : 'declined';
  if (r.visit === 'reschedule' && !r.new_time) r.new_time = ctx.visitTime && /^\d{2}:\d{2}$/.test(ctx.visitTime) && !ctx.tentative ? ctx.visitTime : '11:00';
  if (!r.say) r.say = ruleBased(ctx, '').say;
  return r;
}

/**
 * ctx: { purpose, name, company, project, requirement, visitDate, visitTime, visitDay, tentative, language, facts, orgId }
 * turns: [{ role: 'agent' | 'customer', text }]
 */
async function nextTurn(ctx, turns) {
  const customerTurns = turns.filter((t) => t.role === 'customer');
  const lastText = customerTurns.length ? customerTurns[customerTurns.length - 1].text : '';
  const history = turns.map((t) => ({ role: t.role === 'agent' ? 'model' : 'user', text: t.text }));
  const limit = ctx.purpose === 'enquiry' ? MAX_TURNS + 6 : MAX_TURNS;
  const lastTurn = turns.filter((t) => t.role === 'agent').length >= limit - 1;
  if (lastTurn) history.push({ role: 'user', text: '[system: this is your last reply — wrap up politely now with end_call=true]' });
  const deadlineMs = Number(process.env.VOICE_LLM_DEADLINE_MS || 5000);
  let timer;
  try {
    const apiKey = await settingsService.getGeminiKey(ctx.orgId).catch(() => process.env.GEMINI_API_KEY || null);
    const llm = generateStructured({
      apiKey,
      systemInstruction: systemPrompt(ctx),
      history,
      responseSchema: SCHEMA,
      temperature: 0.4,
      timeoutMs: Number(process.env.VOICE_LLM_TIMEOUT_MS || 2800),
      attemptsPerModel: 1,
      maxModels: 2,
      models: VOICE_MODELS,
      maxOutputTokens: 260,
      thinkingLevel: process.env.GEMINI_VOICE_THINKING || 'minimal',
    });
    llm.catch(() => {}); // a late failure after the deadline must not crash anything
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`LLM took longer than ${deadlineMs}ms`)), deadlineMs); });
    const { parsed, model } = await Promise.race([llm, deadline]);
    clearTimeout(timer);
    const out = clean(parsed, ctx);
    if (lastTurn) out.end_call = true;
    return { ...out, model };
  } catch (err) {
    clearTimeout(timer);
    logger.warn('[voice-agent] LLM failed, using rule fallback', { error: err.message });
    return { ...ruleBased(ctx, lastText), model: 'rules' };
  }
}

/* ---------------- Real-time (streaming) calls ---------------- */

/** Marker the model puts at the very end of its last reply. */
const END_TAG = '[END]';

function speechLanguageRule(language) {
  if (language === 'en') return 'Speak natural, warm Indian English.';
  if (language === 'ar') return 'Speak simple, polite Arabic (Arabic script).';
  const other = otherLanguageRule(language);
  if (other) return other;
  return 'Speak natural spoken Hindi/Hinglish like a friendly Indian tele-caller. Write Hindi in Devanagari script (so the voice pronounces it correctly); common English words (site visit, project, confirm, location, time, WhatsApp, flat, BHK) stay in English letters. Never write Hindi in Roman letters. If the customer asks for English (or answers in plain English when asked their language preference), speak ONLY English from then on, in Latin letters; if they go back to Hindi, switch back.';
}

/**
 * System prompt for live, streaming calls: the model returns ONLY the words
 * to speak (no JSON) so the first sentence can be voiced while the rest is
 * still being written. The call result is read from the transcript separately
 * (extractOutcome).
 */
function realtimePrompt(ctx, { maxTurns = 14 } = {}) {
  const now = istNow();
  const female = platformVoice.agentGender() === 'female';
  const task = taskLine(ctx)
    .replace(/\s*\(visit="\w+"\)/g, '')
    .replace(/\s*→\s*visit="\w+",?/g, ' →')
    .replace(/,?\s*end_call=true/g, ', then say goodbye');
  return [
    `You are ${platformVoice.agentName()}, a ${female ? 'female' : 'male'} sales assistant at ${ctx.company || 'a real-estate company'}. You are on a LIVE PHONE CALL with ${ctx.name || 'a customer'}. You already said the opening line (it is the first message of the conversation).`,
    `TODAY (India time): ${now.date}, ${now.day}, ${now.time}. Resolve "aaj/kal/parso/next Sunday" from this. Never accept or suggest a past date/time.`,
    task,
    speechLanguageRule(ctx.language),
    ...(ctx.region === 'AE' && !ctx.chatLanguage ? ['This customer is in the UAE: speak English by default. If the customer speaks Arabic, reply in Arabic. Never use Hindi or Hinglish with UAE customers unless the customer speaks Hindi first.'] : []),
    female ? 'You are female: use feminine Hindi verbs for yourself (main bol rahi hoon, kar deti hoon).' : 'You are male: use masculine Hindi verbs for yourself (main bol raha hoon, kar deta hoon).',
    '',
    'HOW TO SOUND HUMAN',
    '- Talk like a real person on the phone, not a script: short, warm, relaxed sentences. START every reply with a 1-3 word reaction that ends with punctuation ("जी बिल्कुल!", "अच्छा,", "Got it.") and then continue — this lets your voice start instantly.',
    '- 1-2 short sentences per reply (max ~25 words). Ask only ONE question at a time, and stop talking after a question.',
    '- Spoken style only: no lists, no bullet points, no emojis, no brackets, no markdown, no "Sure! Here is…". Say numbers the way people say them (11 बजे, 2 BHK, 85 लाख).',
    '- If the customer interrupts or changes topic, follow them naturally. If you did not catch something, say so briefly ("सॉरी, फिर से बताइए?").',
    '- Never say you are an AI or a bot unless asked directly; if asked, say honestly that you are the company\'s virtual assistant.',
    '',
    'WHAT TO DO',
    ...(ctx.purpose === 'enquiry' ? [
      '- Agrees to a site visit → fix the day, then the time (one question at a time). Repeat it back (project, day, time), say it is booked and the location will come on WhatsApp, then goodbye.',
      '- Interested but not ready → ask when the team should get back to them, confirm it, goodbye.',
      '- Busy / driving / "call later" → ask when to call back (or say you will send details on WhatsApp), goodbye.',
      '- Not interested / wrong number → apologise politely, goodbye. Never push more than twice.',
    ] : [
      '- Customer will come / says yes → thank them, say location details are sent on WhatsApp, say goodbye.',
      '- Customer cannot come → do not end yet: ask which other day and time suits them, or when the team should call back.',
      '- Customer gives a new day/time → repeat it back clearly (day, date and time) and say it is noted; they will get a WhatsApp to confirm. Then goodbye.',
      '- Busy / driving / "call later" → say you will send the details on WhatsApp, goodbye.',
      '- Wrong number / not interested → apologise politely, goodbye.',
    ]),
    '- Price, location, amenities: answer only from the facts below; otherwise say the team will share details on WhatsApp. Never invent prices or facts.',
    `- Keep the whole call short (at most ${maxTurns} replies).`,
    '',
    `ENDING: when the conversation is over and your reply is the final goodbye, put ${END_TAG} at the very end of that reply. Never use ${END_TAG} otherwise.`,
    ctx.facts ? `\n${ctx.purpose === 'enquiry' ? 'OUR PROPERTIES' : 'FACTS YOU MAY USE'}:\n${ctx.facts}` : '',
    knowledge(ctx),
    ctx.script ? `\nCALL SCRIPT FROM THE COMPANY — follow it in order, in your own natural words, one step at a time (the rules above still apply):\n${String(ctx.script).slice(0, 4000)}` : '',
    '',
    'Reply with ONLY the words you will speak.',
  ].join('\n');
}

const OUTCOME_SCHEMA = {
  type: 'object',
  properties: {
    visit: { type: 'string', enum: ['confirmed', 'declined', 'reschedule', 'unknown'] },
    new_date: { type: ['string', 'null'], description: 'YYYY-MM-DD when the customer agreed a (new) visit date' },
    new_time: { type: ['string', 'null'], description: 'HH:mm 24h when the customer agreed a (new) visit time' },
    follow_up_date: { type: ['string', 'null'], description: 'YYYY-MM-DD when the customer wants to be contacted later instead' },
    interested: { type: ['boolean', 'null'] },
    callback_later: { type: 'boolean', description: 'customer is busy / asked to talk later' },
    summary: { type: 'string', description: 'One short line for the sales team, in English' },
    rating: { type: ['string', 'null'], enum: ['hot', 'warm', 'cold', 'not_interested', null], description: 'Lead calls only: how serious the customer is. hot = wants a site visit / ready to buy soon; warm = interested but undecided; cold = just browsing, low interest; not_interested = said no / wrong number.' },
    rating_reason: { type: ['string', 'null'], description: 'Why, in a few English words' },
    lead: {
      type: 'object',
      description: 'What the customer said about their requirement on this call (null when not mentioned)',
      properties: {
        looking_for: { type: ['string', 'null'], enum: ['buy', 'rent', 'invest', null] },
        location: { type: ['string', 'null'] },
        bhk: { type: ['string', 'null'], description: 'e.g. "2", "3", "2-3", "villa", "plot"' },
        budget_max_inr: { type: ['number', 'null'], description: 'upper budget in rupees (85 lakh = 8500000)' },
        project: { type: ['string', 'null'], description: 'name of the property they liked / will visit (from our list)' },
        timeline: { type: ['string', 'null'], description: 'when they plan to buy, short English' },
        requirement: { type: ['string', 'null'], description: 'one short English line, e.g. "3 BHK in Wakad, ~1.2 Cr, for family"' },
      },
    },
  },
  required: ['visit', 'summary'],
};

function cleanLead(l) {
  if (!l || typeof l !== 'object') return null;
  const str = (v, max = 120) => (typeof v === 'string' && v.trim() && !/^(null|none|n\/a|unknown)$/i.test(v.trim()) ? v.trim().slice(0, max) : null);
  const out = {
    looking_for: ['buy', 'rent', 'invest'].includes(l.looking_for) ? l.looking_for : null,
    location: str(l.location, 80),
    bhk: str(l.bhk, 20),
    budget_max_inr: Number.isFinite(Number(l.budget_max_inr)) && Number(l.budget_max_inr) >= 100000 ? Math.round(Number(l.budget_max_inr)) : null,
    project: str(l.project, 80),
    timeline: str(l.timeline, 60),
    requirement: str(l.requirement, 200),
  };
  return Object.values(out).some((v) => v !== null) ? out : null;
}

function cleanRating(v, out) {
  let r = ['hot', 'warm', 'cold', 'not_interested'].includes(v) ? v : null;
  if (out?.visit === 'confirmed' && out?.new_date) r = 'hot'; // a booked visit is always hot
  if (!r && out?.interested === false) r = 'not_interested';
  return r;
}

/**
 * Reads a (live or finished) call transcript and returns what the customer
 * decided, in the same shape as nextTurn() minus "say".
 */
async function extractOutcome(ctx, turns, { timeoutMs = 7000 } = {}) {
  const now = istNow();
  const transcript = turns
    .filter((t) => t && t.text)
    .map((t) => `${t.role === 'agent' ? 'AGENT' : 'CUSTOMER'}: ${t.text}`)
    .join('\n');
  if (!turns.some((t) => t.role === 'customer')) return null;
  const apiKey = await settingsService.getGeminiKey(ctx.orgId).catch(() => process.env.GEMINI_API_KEY || null);
  const system = [
    'You read a phone call between a real-estate company agent and a customer and report what the CUSTOMER decided. Only report what the customer clearly said or agreed to.',
    `TODAY (India time): ${now.date}, ${now.day}. Resolve relative days from this.`,
    ...(ctx.purpose === 'enquiry'
      ? [
        'This was a LEAD CALL (no visit was booked before the call).',
        'visit: "confirmed" = the customer agreed to come for a site visit on a specific day (fill new_date and new_time; if no time was agreed leave new_time null); "declined" = does not want a visit now; "unknown" = undecided.',
        'interested: true when they showed interest in buying/renting or in a property; false when not interested / wrong number.',
      ]
      : [
        taskLine(ctx).replace(/Your job:.*$/s, ''),
        'visit: "confirmed" = will come at the booked time; "reschedule" = agreed a different day/time (fill new_date/new_time); "declined" = cannot come and gave no new date; "unknown" = no decision yet.',
      ]),
    ...(ctx.purpose === 'enquiry' ? ['rating (lead calls): hot = agreed to a site visit or is ready to buy soon; warm = interested / asked for details but undecided; cold = polite but low interest or just browsing; not_interested = said no, wrong number. Judge only from what the customer said.'] : []),
    'lead: fill only what the customer actually said about their requirement.',
    'follow_up_date: only when they asked to be contacted on/after a specific later date. callback_later: busy / asked to call later. interested: false for wrong number / not interested.',
    'summary: one short English line for the sales team.',
  ].join('\n');
  const { parsed, model } = await generateStructured({
    apiKey,
    systemInstruction: system,
    history: [{ role: 'user', text: transcript.slice(-12000) }],
    responseSchema: OUTCOME_SCHEMA,
    temperature: 0.1,
    timeoutMs,
    attemptsPerModel: 1,
    maxModels: 3,
    models: VOICE_MODELS,
    maxOutputTokens: 300,
    thinkingLevel: 'minimal',
  });
  const out = clean({ ...parsed, say: '-' }, ctx);
  delete out.say;
  delete out.end_call;
  // Enquiry call: a visit agreed on the call is a booking (needs a date).
  if (ctx.purpose === 'enquiry' && out.visit === 'confirmed' && !out.new_date) out.visit = 'unknown';
  if (ctx.purpose === 'enquiry' && out.visit === 'confirmed' && !out.new_time) out.new_time = '11:00';
  const rating = ctx.purpose === 'enquiry' ? cleanRating(parsed.rating, out) : null;
  return { ...out, lead: cleanLead(parsed.lead), rating, rating_reason: rating && parsed.rating_reason ? String(parsed.rating_reason).slice(0, 120) : null, model };
}

module.exports = { nextTurn, systemPrompt, ruleBased, MAX_TURNS, realtimePrompt, extractOutcome, END_TAG, VOICE_MODELS, istNow };
