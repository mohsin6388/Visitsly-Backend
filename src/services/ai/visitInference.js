/**
 * Safety net for site-visit booking in the WhatsApp chat.
 *
 * The LLM is supposed to set wantsSiteVisit / proposedDate / proposedTime when the customer agrees to a
 * visit. When it forgets (free-tier model, 429/503 fallbacks, flash-lite…) the customer hears "our team will
 * call you to confirm" but no visit is ever created, so no confirmation call goes out.
 *
 * This module decides — from plain text, no LLM — whether the customer just answered the bot's
 * "which day / time?" (or "would you like a site visit?") question, and extracts the day and time.
 */

const DAY_NAMES = {
  sunday: 0, ravivar: 0, ravivaar: 0, sunday_: 0,
  monday: 1, somvar: 1, somvaar: 1,
  tuesday: 2, mangalvar: 2, mangalvaar: 2,
  wednesday: 3, budhvar: 3, budhvaar: 3,
  thursday: 4, guruvar: 4, guruvaar: 4, veervar: 4, brihaspativar: 4,
  friday: 5, shukravar: 5, shukravaar: 5,
  saturday: 6, shanivar: 6, shanivaar: 6, shaniwar: 6,
};

const ASKED_WHEN = /(kaunsa din|kaun sa din|kis din|kab aa|which day|what day|what time|din aur time|day and time|date aur time|kitne baje|kab tak)/i;
const ASKED_VISIT = /site visit|visit karna|visit kar|visit schedule|visit book|property dekhne|dekhne aa/i;
const NEGATIVE = /\b(nahi|nahin|nhi|no|not now|cancel|mat|busy|later|baad mein|baad me)\b|नहीं|नही/i;
const YES = /^(\s*)(haan|haa+|han|hanji|ha|ji|ji haan|yes|yeah|yep|sure|ok|okay|ohkay|okk+|theek hai|thik hai|bilkul|zaroor|pakka|done|हाँ|हां|जी|ठीक है)\b/i;

function pad(n) { return String(n).padStart(2, '0'); }

/** IST calendar date (YYYY-MM-DD) `offset` days from today. */
function istDate(offset = 0, now = Date.now()) {
  const d = new Date(now + 330 * 60000 + offset * 86400000);
  return d.toISOString().slice(0, 10);
}
function istWeekday(now = Date.now()) {
  return new Date(now + 330 * 60000).getUTCDay();
}

/** { date, time } picked out of a customer message (either may be null). */
function parseWhen(text, now = Date.now()) {
  const t = String(text || '').toLowerCase();
  let date = null;
  if (/\b(parso|parson|parsu|day after tomorrow)\b|परसों/.test(t)) date = istDate(2, now);
  else if (/\b(kal|kl|tomorrow|tmrw|tommorow|tomorow)\b|कल/.test(t)) date = istDate(1, now);
  else if (/\b(aaj|aj|today)\b|आज/.test(t)) date = istDate(0, now);
  else {
    for (const [name, dow] of Object.entries(DAY_NAMES)) {
      if (new RegExp(`\\b${name}\\b`).test(t)) {
        const diff = (dow - istWeekday(now) + 7) % 7 || 7;
        date = istDate(diff, now);
        break;
      }
    }
  }

  const morning = /\b(subah|subha|subhah|morning|savere)\b|सुबह/.test(t);
  const afternoon = /\b(dopahar|dophar|afternoon)\b|दोपहर/.test(t);
  const evening = /\b(shaam|sham|evening)\b|शाम/.test(t);
  let time = null;
  const m = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|baje|bje|o'?clock)\b/.exec(t);
  if (m) {
    let h = Number(m[1]);
    const min = m[2] ? Number(m[2]) : 0;
    const unit = m[3];
    if (h <= 23 && min <= 59) {
      if (unit === 'pm' && h < 12) h += 12;
      else if (unit === 'am' && h === 12) h = 0;
      else if (!/am|pm/.test(unit) && h >= 1 && h <= 6 && !morning) h += 12; // "5 baje" → 5 pm
      time = `${pad(h)}:${pad(min)}`;
    }
  } else if (morning) time = '11:00';
  else if (afternoon) time = '14:00';
  else if (evening) time = '17:00';
  return { date, time };
}

/**
 * @param {object} p
 * @param {Array}  p.recentMessages  oldest → newest (Message docs, before the AI reply is saved)
 * @param {string} p.currentMessage  the customer's latest text
 * @param {string} p.messageType     WhatsApp message type
 * @returns {null | {date: string|null, time: string|null, reason: string}}
 */
function inferVisitFromChat({ recentMessages = [], currentMessage = '', messageType = 'text' } = {}) {
  if (['image', 'video', 'audio', 'document', 'sticker'].includes(messageType)) return null;
  const text = String(currentMessage || '').trim();
  if (!text || text.length > 160 || NEGATIVE.test(text)) return null;

  const prev = [...recentMessages].reverse().find((m) => m.direction === 'outbound');
  const prevText = String(prev?.text || '');
  if (!prevText) return null;

  // Bot asked "which day / time?" (or invited them for a visit) and the customer named a day.
  // A visit is booked only with a real date — a bare "haan" just moves the chat to the day/time question.
  if (ASKED_WHEN.test(prevText) || (ASKED_VISIT.test(prevText) && prevText.includes('?'))) {
    const { date, time } = parseWhen(text);
    if (date) return { date, time, reason: 'answered_day_time' };
  }
  return null;
}

module.exports = { inferVisitFromChat, parseWhen };
