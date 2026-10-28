const axios = require('axios');
const Organization = require('../../models/Organization');
const Lead = require('../../models/Lead');
const Message = require('../../models/Message');
const Meeting = require('../../models/Meeting');
const CallLog = require('../../models/CallLog');
const Notification = require('../../models/Notification');
const ApiError = require('../../utils/ApiError');
const { decrypt } = require('../../utils/crypto');
const tenantContext = require('../../context/tenantContext');
const orgService = require('../saas/orgService');
const logger = require('../../utils/logger');

/**
 * AI voice calling through Bolna (Hindi / Hinglish voice agents on Indian
 * numbers). The company creates its agent in Bolna (prompt, voice, number)
 * and pastes the API key + agent id in PropAI → Settings → AI calling.
 *
 * PropAI passes lead context (name, project, budget, company) as user_data,
 * and Bolna posts the result to /api/webhooks/voice/:captureKey. Minutes are
 * metered per company for the ₹/minute add-on.
 */
const BOLNA = 'https://api.bolna.ai';
const http = axios.create({ timeout: 20000 });

async function voiceConfig(orgId) {
  const org = await Organization.findById(orgId).select('+voice.apiKeyEncrypted voice leadCapture.key name').lean();
  const v = org?.voice || {};
  return { ...v, apiKey: v.apiKeyEncrypted ? decrypt(v.apiKeyEncrypted) : null, captureKey: org?.leadCapture?.key, companyName: org?.name };
}

function e164(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length === 10) return `+91${d}`;
  return d ? `+${d}` : null;
}

/** Must run inside the company's tenant context. */
async function placeCall(lead, { trigger = 'manual', requestedBy = null, publicBase } = {}) {
  const org = tenantContext.getOrg();
  if (!org) throw new Error('placeCall needs a tenant context');
  const { subscriptionState } = require('../saas/subscription');
  if (!subscriptionState(org).active) throw ApiError.forbidden('Subscription active nahi hai');
  const cfg = await voiceConfig(org._id);
  if (!cfg.enabled || !cfg.apiKey || !cfg.agentId) throw ApiError.badRequest('AI calling set nahi hai — Settings → AI calling mein Bolna API key aur agent ID daaliye');
  const to = e164(lead.phone);
  if (!to) throw ApiError.badRequest('Lead ka phone number nahi hai');

  const log = await CallLog.create({ ownerId: org.ownerUserId, leadId: lead._id, trigger, requestedBy });
  try {
    const { data } = await http.post(
      `${BOLNA}/call`,
      {
        agent_id: cfg.agentId,
        recipient_phone_number: to,
        ...(cfg.fromNumber ? { from_phone_number: e164(cfg.fromNumber) } : {}),
        user_data: {
          lead_name: lead.name,
          company_name: cfg.companyName,
          project: lead.project || '',
          city: lead.city || '',
          budget: lead.budgetMax ? `${Math.round(lead.budgetMax / 100000)} lakh` : '',
          requirement: lead.requirements || '',
          propai_call_id: String(log._id),
          ...(publicBase && cfg.captureKey ? { webhook_hint: `${publicBase}/api/webhooks/voice/${cfg.captureKey}` } : {}),
        },
      },
      { headers: { Authorization: `Bearer ${cfg.apiKey}` } }
    );
    log.executionId = data.execution_id || null;
    log.status = data.status || 'queued';
    await log.save();
    return log;
  } catch (err) {
    log.status = 'failed';
    log.error = err.response?.data?.message || err.message;
    await log.save();
    throw ApiError.badRequest(`Call nahi laga: ${log.error}`);
  }
}

const FINAL = ['completed', 'call-disconnected', 'failed', 'no-answer', 'busy', 'canceled', 'cancelled', 'error', 'stopped'];

/** Bolna execution webhook → update call, meter minutes, note + score the lead, book visit. */
async function handleExecution(org, payload) {
  const execId = payload.id || payload.execution_id;
  let log = execId ? await CallLog.findOne({ executionId: execId }) : null;
  const callId = payload.user_data?.propai_call_id || payload.context_details?.recipient_data?.propai_call_id;
  if (!log && callId) log = await CallLog.findById(callId);
  if (!log) return null;

  const status = String(payload.status || payload.smart_status || log.status).toLowerCase();
  log.status = status;
  const td = payload.telephony_data || {};
  const duration = Number(payload.conversation_duration ?? td.duration ?? 0);
  if (duration) log.durationSec = Math.round(duration);
  if (payload.total_cost != null) log.cost = Number(payload.total_cost);
  if (td.recording_url || payload.recording_url) log.recordingUrl = td.recording_url || payload.recording_url;
  if (payload.transcript) log.transcript = String(payload.transcript).slice(0, 20000);
  if (payload.summary) log.summary = String(payload.summary).slice(0, 4000);
  const extracted = payload.extracted_data || {};
  if (Object.keys(extracted).length) log.extracted = extracted;

  const done = status === 'completed';
  if (done && !log.billedMinutes && log.durationSec > 0) {
    log.billedMinutes = Math.ceil(log.durationSec / 60);
    await orgService.incrementUsage(org._id, 'voiceMinutes', log.billedMinutes);
  }

  // Interpret common extraction keys (configure these in the Bolna agent).
  const yes = (v) => /^(yes|true|haan|ha|interested|1)$/i.test(String(v || '').trim());
  if (extracted.interested !== undefined) log.interested = yes(extracted.interested);
  const visitDate = extracted.visit_date || extracted.site_visit_date;
  const visitTime = extracted.visit_time || extracted.site_visit_time || '11:00';
  await log.save();

  if (done) {
    const lead = await Lead.findById(log.leadId);
    if (lead) {
      const line = `[AI call ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}] ${log.durationSec}s${log.summary ? ` — ${log.summary}` : ''}`;
      lead.notes = [lead.notes, line].filter(Boolean).join('\n').slice(-5000);
      if (log.interested === true && lead.leadScore < 45) lead.leadScore = 45;
      if (log.interested === false && lead.status === 'new') lead.status = 'cold';
      await lead.save();

      if (visitDate && /^\d{4}-\d{2}-\d{2}$/.test(String(visitDate)) && !log.visitBooked) {
        await Meeting.create({ leadId: lead._id, ownerId: lead.ownerId, preferredDate: String(visitDate), preferredTime: /^\d{2}:\d{2}$/.test(String(visitTime)) ? String(visitTime) : '11:00', source: 'voice_ai', notes: 'AI call se book hua' });
        log.visitBooked = true;
        await log.save();
        lead.status = 'site_visit';
        await lead.save();
      }
      await Notification.create({
        userId: lead.ownerId,
        type: 'ai_call',
        title: `AI call: ${lead.name}${log.visitBooked ? ' — visit book!' : log.interested ? ' — interested' : ''}`,
        body: log.summary ? log.summary.slice(0, 280) : `${log.durationSec}s call`,
        link: `/whatsapp/conversations?lead=${lead._id}`,
      }).catch(() => {});
    }
  }
  return log;
}

/* -------- Auto-call new leads that haven't replied on WhatsApp -------- */
async function autoCallTick() {
  const hourIST = new Date(Date.now() + 330 * 60000).getUTCHours();
  if (hourIST < 10 || hourIST >= 19) return; // polite calling hours
  const orgs = await Organization.find({ 'voice.enabled': true, 'voice.autoCallNewLeads': true, status: { $in: ['trialing', 'active', 'past_due'] } }).select('_id ownerUserId voice').lean();
  for (const o of orgs) {
    const after = (o.voice.autoCallAfterMinutes || 30) * 60000;
    const leads = await Lead.find({
      ownerId: o.ownerUserId,
      phone: { $ne: null },
      createdAt: { $gte: new Date(Date.now() - 6 * 3600000), $lte: new Date(Date.now() - after) },
      source: { $nin: ['csv_import', 'manual', 'whatsapp_inbound'] }, // only fresh enquiries (forms, ads, portals, CPs)
    }).limit(50).lean();
    for (const lead of leads) {
      if (await CallLog.exists({ leadId: lead._id })) continue;
      if (await Message.exists({ leadId: lead._id, direction: 'inbound' })) continue;
      await orgService.runForOrg(o._id, () => placeCall(lead, { trigger: 'auto_new_lead' })).catch((err) => logger.warn('[voice] auto call failed', { lead: String(lead._id), error: err.message }));
    }
  }
}

let handle = null;
function startAutoCallScheduler() {
  if (handle) return;
  handle = setInterval(() => autoCallTick().catch((err) => logger.error('[voice] tick failed', { error: err.message })), 2 * 60 * 1000);
}

module.exports = { placeCall, handleExecution, startAutoCallScheduler, voiceConfig, autoCallTick };
