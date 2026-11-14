const Lead = require('../../models/Lead');
const Conversation = require('../../models/Conversation');
const Message = require('../../models/Message');
const LeadScore = require('../../models/LeadScore');
const FollowUp = require('../../models/FollowUp');
const Notification = require('../../models/Notification');

const settingsService = require('../settings/settingsService');
const { generateStructured } = require('./geminiClient');
const { emitToUser } = require('../../sockets');
const logger = require('../../utils/logger');
const EmailMessage = require('../../models/EmailMessage');
const { levelForScore, LEAD_SCORE, HOT_SCORE } = require('../../config/leadRules');

const ANALYSIS_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'number', description: '0-100 lead quality score' },
    level: { type: 'string', enum: ['cold', 'warm', 'hot'] },
    interestLevel: { type: 'string' },
    buyingIntent: { type: 'string' },
    budgetMatch: { type: 'boolean' },
    closingProbability: { type: 'number', description: '0-100' },
    summary: { type: 'string', description: 'ONE short line (max 20 words): who the buyer is and where things stand.' },
    requirement: { type: 'string', description: 'Short requirement line like "2 BHK · Noida Sec 150 · ₹80L-1Cr · within 3 months". Empty string if unknown.' },
    memory: { type: 'string', description: 'Compact facts to remember for future chats (max 500 chars): chosen language, name, requirement, budget, locations, projects discussed, objections, visit plans, promises made.' },
    reason: { type: 'string', description: 'Why this score was given.' },
    nextFollowUpDate: { type: 'string', description: 'ISO date (YYYY-MM-DD) for the next follow-up.' },
    nextFollowUpMessage: { type: 'string', description: 'A draft opening line for the next follow-up message.' },
    urgency: { type: 'string', enum: ['low', 'medium', 'high'] },
    buyingProbability: { type: 'number', description: '0-100' },
  },
  required: ['score', 'level', 'summary', 'requirement', 'memory', 'reason', 'nextFollowUpDate', 'nextFollowUpMessage', 'urgency'],
};

function istToday() {
  return new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
}

/**
 * Follow-up dates must be in the future and sensible. The model sometimes
 * returns a past date (it doesn't know "today") — clamp to today+N by urgency.
 */
function sanitizeFollowUpDate(raw, { score, urgency }) {
  const today = istToday();
  const fallbackDays = score > HOT_SCORE || urgency === 'high' ? 1 : score > LEAD_SCORE || urgency === 'medium' ? 2 : 5;
  const fallback = new Date(`${today}T10:30:00+05:30`);
  fallback.setUTCDate(fallback.getUTCDate() + fallbackDays);
  const m = String(raw || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return fallback;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T10:30:00+05:30`);
  if (Number.isNaN(d.getTime())) return fallback;
  const tomorrow = new Date(`${today}T10:30:00+05:30`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const max = new Date(`${today}T10:30:00+05:30`);
  max.setUTCDate(max.getUTCDate() + 30);
  if (d < tomorrow) return fallbackDays <= 1 ? tomorrow : fallback;
  if (d > max) return max;
  return d;
}

function buildAnalysisPrompt(lead) {
  return `Today's date (India time) is ${istToday()}. All dates you return must be AFTER today.

You are a real estate sales analyst reviewing the WhatsApp and email conversation between a sales executive (or the AI assistant) and a buyer named ${lead.name}.

Scoring scale used by the CRM: 0-${LEAD_SCORE} = not a lead yet (no real interest), ${LEAD_SCORE + 1}-${HOT_SCORE} = lead (some genuine interest), above ${HOT_SCORE} = hot lead (clear intent: budget, location, timeline, visit or price discussion).

Read the full conversation history and return a structured analysis:
- A lead quality score (0-100) and level (cold/warm/hot) based on genuine buying signals, not politeness.
- Their real interest level and buying intent.
- Whether their budget realistically matches what's being discussed.
- A closing probability (0-100).
- summary: ONE short line (max 20 words). requirement: a compact line like "2 BHK · Noida · ₹80L-1Cr".
- memory: compact facts to remember for the next chat (language, name, needs, objections, promises, visit plans).
- The reasoning behind your score (one sentence).
- A sensible next follow-up date (consider urgency — hot leads get followed up sooner, within 1-2 days; cold leads can wait longer) and a natural draft opening line for that follow-up.
- Urgency level and an overall buying probability.

Be realistic and conservative — don't inflate scores just because the buyer was polite.`;
}

const POSITIVE_SIGNALS = [
  /price|rate|cost|kitna|kitne|budget|lakh|lac|crore|\bcr\b/i,
  /\bbhk\b|flat|villa|plot|apartment|property|ghar|house/i,
  /visit|site|dekhna|dikhao|location|address|kab|when|timing/i,
  /loan|emi|booking|book|token|payment|available|possession/i,
  /interested|yes|haan|ha\b|ok|sure|details|brochure|call me|call kar/i,
];
const NEGATIVE_SIGNAL = /not interested|no need|nahi chahiye|mat bhejo|stop|unsubscribe|remove me|wrong number|galat number/i;

/**
 * Fallback scorer used only when no Gemini key is configured, so the lead
 * rules (score > 30 = lead, > 60 = hot) still work. Deliberately simple and
 * conservative: a single "ok" reply stays below the lead line.
 */
function heuristicAnalysis(lead, entries) {
  const replies = entries.filter((e) => e.fromCustomer).map((e) => e.text || '');
  const joined = replies.join(' \n ');
  if (NEGATIVE_SIGNAL.test(joined)) {
    return { score: 10, summary: `${lead.name || 'Customer'} ne mana kar diya / interest nahi dikhaya.`, reason: 'Negative reply detected.', urgency: 'low' };
  }
  const hits = POSITIVE_SIGNALS.filter((re) => re.test(joined)).length;
  const score = Math.min(100, 10 + Math.min(15, replies.length * 5) + hits * 12);
  const last = replies[replies.length - 1] || '';
  return {
    score,
    summary: `${lead.name || 'Customer'} ne ${replies.length} baar reply kiya. Aakhri reply: "${last.slice(0, 140)}"`,
    reason: `Keyword-based score (no AI key configured): ${hits} buying signal(s), ${replies.length} reply(s).`,
    urgency: score > HOT_SCORE ? 'high' : score > LEAD_SCORE ? 'medium' : 'low',
  };
}

/** WhatsApp + email history for one lead, oldest first. */
async function loadLeadTranscript(leadId) {
  const [waMessages, emails] = await Promise.all([
    Message.find({ leadId }).sort({ timestamp: -1 }).limit(60).lean(),
    EmailMessage.find({ leadId, status: { $nin: ['queued', 'cancelled', 'failed'] } }).sort({ createdAt: -1 }).limit(20).lean(),
  ]);
  const entries = [
    ...waMessages.map((m) => ({
      at: new Date(m.timestamp || m.createdAt),
      fromCustomer: m.direction === 'inbound' && m.sender === 'customer',
      text: m.text || '',
      channel: 'WhatsApp',
    })),
    ...emails.map((e) => ({
      at: new Date(e.receivedAt || e.sentAt || e.createdAt),
      fromCustomer: e.direction === 'inbound',
      text: [e.subject ? `Subject: ${e.subject}` : '', String(e.text || '').slice(0, 1500)].filter(Boolean).join('\n'),
      channel: 'Email',
    })),
  ];
  return entries.sort((a, b) => a.at - b.at);
}

/** Backwards-compatible entry point used by the WhatsApp conversation engine. */
async function analyzeConversationAsync({ leadId, conversationId }) {
  return analyzeLeadAsync({ leadId, conversationId });
}

/**
 * Scores a lead from everything they said on WhatsApp and email, then
 * persists score, temperature (cold/warm/hot from the CRM thresholds),
 * summary and the next follow-up. Leads that never replied are not scored.
 */
async function analyzeLeadAsync({ leadId, conversationId = null }) {
  const lead = await Lead.findById(leadId);
  if (!lead) return;
  const entries = await loadLeadTranscript(leadId);
  if (!entries.some((e) => e.fromCustomer)) return; // no reply yet → not a lead

  if (!conversationId) {
    const conversation = await Conversation.findOne({ leadId }).select('_id').lean();
    conversationId = conversation?._id || null;
  }

  const transcript = entries
    .map((e) => `[${e.channel}] ${e.fromCustomer ? 'Buyer' : 'Sales Exec'}: ${e.text}`)
    .join('\n');

  let parsed;
  const apiKey = await settingsService.getGeminiKey();
  if (apiKey) {
    try {
      ({ parsed } = await generateStructured({
        apiKey,
        systemInstruction: buildAnalysisPrompt(lead),
        history: [{ role: 'user', text: transcript }],
        responseSchema: ANALYSIS_RESPONSE_SCHEMA,
        temperature: 0.3, // scoring should be consistent, not creative
      }));
    } catch (err) {
      logger.error(`[ai] Lead analysis Gemini call failed for lead ${leadId}`, { error: err.message });
    }
    // A temporary AI failure keeps the previous score instead of overwriting it.
    if (!parsed || typeof parsed.score !== 'number') return;
  }
  if (!parsed) {
    const fallback = heuristicAnalysis(lead, entries);
    const days = fallback.score > HOT_SCORE ? 1 : fallback.score > LEAD_SCORE ? 3 : 7;
    parsed = {
      ...fallback,
      nextFollowUpDate: new Date(Date.now() + days * 86400000).toISOString().slice(0, 10),
      nextFollowUpMessage: `Namaste ${lead.name || ''}, aapki property requirement par aage baat karein?`.replace(/\s+,/, ','),
      modelVersion: 'heuristic',
    };
  }

  const score = clamp(parsed.score, 0, 100);
  // The CRM thresholds decide the temperature, not the model's own label.
  parsed.level = levelForScore(score);

  await LeadScore.create({
    leadId,
    score,
    level: parsed.level,
    modelVersion: parsed.modelVersion || 'gemini',
    interestLevel: parsed.interestLevel || null,
    buyingIntent: parsed.buyingIntent || null,
    budgetMatch: parsed.budgetMatch ?? null,
    closingProbability: parsed.closingProbability != null ? clamp(parsed.closingProbability, 0, 100) : null,
    summary: parsed.summary,
    reason: parsed.reason,
  });

  const wasHotBefore = lead.status === 'hot';
  lead.leadScore = score;
  // Only auto-promote status via score for leads still in the AI-qualification
  // funnel — never downgrade/override a broker's manual closed/lost/site_visit call.
  if (!['closed', 'lost', 'site_visit'].includes(lead.status)) {
    lead.status = parsed.level; // 'cold' | 'warm' | 'hot' — all valid Lead.STATUSES values
  }
  await lead.save();

  const shortSummary = [String(parsed.summary || '').trim(), String(parsed.requirement || '').trim() ? `Requirement: ${String(parsed.requirement).trim()}` : '']
    .filter(Boolean)
    .join('\n')
    .slice(0, 400);
  if (conversationId) {
    await Conversation.updateOne(
      { _id: conversationId },
      {
        $set: {
          aiSummary: shortSummary,
          currentLeadScore: score,
          ...(parsed.memory ? { memory: String(parsed.memory).slice(0, 1200) } : {}),
        },
      }
    );
  }

  if (parsed.nextFollowUpDate) {
    await FollowUp.findOneAndUpdate(
      { leadId, status: 'pending', kind: { $ne: 'sequence' } },
      {
        leadId,
        kind: 'ai',
        ownerId: lead.ownerId,
        nextFollowUpDate: sanitizeFollowUpDate(parsed.nextFollowUpDate, { score, urgency: parsed.urgency }),
        nextFollowUpMessage: parsed.nextFollowUpMessage,
        urgency: parsed.urgency || 'medium',
        buyingProbability: parsed.buyingProbability != null ? clamp(parsed.buyingProbability, 0, 100) : null,
        status: 'pending',
        generatedBy: parsed.modelVersion || 'gemini',
      },
      { upsert: true, new: true }
    );
  }

  // Instant owner alert (WhatsApp → template → email) once per temperature.
  try {
    const settings = await settingsService.getOrCreateSettings();
    const wantsHot = settings.alertOn?.hotLead !== false;
    const alertEnabledForLevel = wantsHot && (parsed.level === 'hot' || (parsed.level === 'warm' && settings.leadAlertLevel === 'hot_warm'));
    const alertTimestampField = parsed.level === 'hot' ? 'hotAlertSentAt' : 'warmAlertSentAt';
    if (alertEnabledForLevel && !lead[alertTimestampField]) {
      // Atomic claim prevents two overlapping analysis runs from notifying twice.
      const claim = await Lead.findOneAndUpdate(
        { _id: lead._id, [alertTimestampField]: null },
        { $set: { [alertTimestampField]: new Date() } },
        { new: true },
      );
      if (claim) {
        const { sendOwnerAlert } = require('../alerts/ownerAlerts');
        await sendOwnerAlert({
          kind: 'hot_lead',
          title: `🔥 ${parsed.level === 'hot' ? 'HOT' : 'WARM'} LEAD — ${lead.name || 'New buyer'}`,
          lines: [
            `📞 ${lead.phone || '-'}${lead.email ? ` · ${lead.email}` : ''}`,
            parsed.requirement ? `🏠 ${parsed.requirement}` : '',
            `⭐ Score ${score}/100`,
            parsed.summary ? `📝 ${parsed.summary}` : '',
            lead.source ? `📍 Source: ${String(lead.source).replace(/_/g, ' ')}` : '',
            'Abhi call karein — jaldi baat karne se visit chance badhta hai.',
          ],
          link: `/whatsapp/conversations?lead=${lead._id}`,
          templateValues: [lead.name || 'Lead', lead.phone || '-', lead.email || '-', String(score), parsed.summary || parsed.requirement || 'Interested buyer'],
        });
      }
    }
  } catch (alertErr) {
    logger.warn('[ai] Could not send owner lead alert', { error: alertErr.message });
  }

  emitToUser(lead.ownerId, 'lead:scored', { leadId, score, level: parsed.level });
}

function clamp(n, min, max) {
  if (typeof n !== 'number' || Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}

module.exports = { analyzeConversationAsync, analyzeLeadAsync, heuristicAnalysis };
