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
const VOICE_MODELS = String(process.env.GEMINI_VOICE_MODELS || 'gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-2.5-flash-lite,gemini-2.5-flash')
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
    summary: { type: 'string', description: 'One short line for the sales team (Hinglish, Roman script)' },
  },
  required: ['say', 'end_call', 'visit', 'summary'],
};

function istNow() {
  const d = new Date(Date.now() + 330 * 60000);
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return { date: d.toISOString().slice(0, 10), day: days[d.getUTCDay()], time: d.toISOString().slice(11, 16) };
}

function languageRule(language) {
  if (language === 'en') return 'Speak natural Indian English.';
  if (language === 'ar') return 'Speak simple, polite Arabic. Write "say" in Arabic script.';
  return 'Speak natural spoken Hindi/Hinglish like a polite Indian tele-caller. Write "say" in Devanagari script (so the voice pronounces it correctly); common English words like site visit, project, confirm, location, time, WhatsApp can stay in English letters. Never write Hindi in Roman script in "say".';
}

function systemPrompt(ctx) {
  const now = istNow();
  const female = platformVoice.agentGender() === 'female';
  const visitLine = ctx.purpose === 'visit_confirmation'
    ? ctx.tentative
      ? `The customer agreed to a site visit but NO date/time is fixed yet. Your job: get a day and time for the visit${ctx.project ? ` to ${ctx.project}` : ''}.`
      : `Site visit booked: ${ctx.project ? `project "${ctx.project}", ` : ''}date ${ctx.visitDate} (${ctx.visitDay}), time ${ctx.visitTime}. Your job: confirm the customer will come.`
    : `The customer recently enquired${ctx.project ? ` about "${ctx.project}"` : ''}${ctx.requirement ? ` (requirement: ${ctx.requirement})` : ''}. Your job: check interest briefly and invite them for a site visit; if they agree, get a day and time.`;

  return [
    `You are ${platformVoice.agentName()}, a ${female ? 'female' : 'male'} phone assistant for ${ctx.company || 'a real-estate company'} (real estate). You are ON A LIVE PHONE CALL with ${ctx.name || 'a customer'}.`,
    `TODAY (India time): ${now.date}, ${now.day}, ${now.time}. Resolve "aaj/kal/parso/next Sunday" from this. Never accept or suggest a past date/time.`,
    visitLine,
    languageRule(ctx.language),
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
    `- The call must finish within ${MAX_TURNS} replies; when it is the last one, wrap up politely with end_call=true.`,
    ctx.facts ? `\nFACTS YOU MAY USE:\n${ctx.facts}` : '',
    '',
    'Return ONLY a JSON object: {"say","end_call","visit","new_date","new_time","follow_up_date","interested","callback_later","summary"}.',
  ].filter((l) => l !== null).join('\n');
}

const YES = /\b(haan|haa|han|ha|hanji|ji haan|yes|yeah|yep|sure|okay|ok|theek hai|thik hai|bilkul|zaroor|pakka|aa jaunga|aa jaungi|aa jayenge|aaunga|aaungi|confirm)\b|हाँ|हां|जी|ठीक|बिल्कुल|ज़रूर|जरूर|पक्का|आ जा/i;
const NO = /\b(nahi|nahin|nhi|no|cancel|not coming|cannot|can't|busy|baad mein)\b|नहीं|नही|कैंसल|बाद में/i;

/** Last-resort decision when both LLMs are down. */
function ruleBased(ctx, text) {
  const hi = ctx.language !== 'en' && ctx.language !== 'ar';
  const female = platformVoice.agentGender() === 'female';
  if (NO.test(text)) {
    return {
      say: hi ? `कोई बात नहीं। मैं आपको WhatsApp पर message ${female ? 'कर देती' : 'कर देता'} हूँ, वहाँ आप अपना सही दिन और time बता दीजिए। धन्यवाद!` : 'No problem. I will message you on WhatsApp — please share a day and time that suits you there. Thank you!',
      end_call: true, visit: 'declined', summary: 'Customer ne call par mana kiya (AI fallback).',
    };
  }
  if (YES.test(text) && ctx.purpose === 'visit_confirmation' && !ctx.tentative) {
    return {
      say: hi ? 'बहुत बढ़िया! आपकी site visit confirm है। Location details WhatsApp पर भेज दी जाएँगी। धन्यवाद!' : 'Great! Your site visit is confirmed. We will send the location on WhatsApp. Thank you!',
      end_call: true, visit: 'confirmed', summary: 'Customer ne call par visit confirm ki.',
    };
  }
  return {
    say: hi ? `ठीक है, मैं आपको WhatsApp पर details ${female ? 'भेज देती' : 'भेज देता'} हूँ। धन्यवाद!` : 'Alright, I will send you the details on WhatsApp. Thank you!',
    end_call: true, visit: 'unknown', summary: 'Call par saaf jawab nahi mila.',
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
  const lastTurn = turns.filter((t) => t.role === 'agent').length >= MAX_TURNS - 1;
  if (lastTurn) history.push({ role: 'user', text: '[system: this is your last reply — wrap up politely now with end_call=true]' });
  const deadlineMs = Number(process.env.VOICE_LLM_DEADLINE_MS || 8000);
  let timer;
  try {
    const apiKey = await settingsService.getGeminiKey(ctx.orgId).catch(() => process.env.GEMINI_API_KEY || null);
    const llm = generateStructured({
      apiKey,
      systemInstruction: systemPrompt(ctx),
      history,
      responseSchema: SCHEMA,
      temperature: 0.4,
      timeoutMs: Number(process.env.VOICE_LLM_TIMEOUT_MS || 4500),
      attemptsPerModel: 1,
      maxModels: 2,
      models: VOICE_MODELS,
      maxOutputTokens: 400,
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

module.exports = { nextTurn, systemPrompt, ruleBased, MAX_TURNS };
