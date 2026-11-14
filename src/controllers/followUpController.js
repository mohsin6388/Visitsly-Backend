const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const FollowUp = require('../models/FollowUp');
const Conversation = require('../models/Conversation');

function scopeOwnerId(req) {
  if (req.user.role === 'admin' && req.query.ownerId) return req.query.ownerId;
  return req.user.id;
}

/** GET /api/followups — pending follow-ups queue, oldest-due first. */
const listFollowUps = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const { status, page, limit } = req.query;

  const filter = { ownerId };
  filter.status = status || 'pending';

  const [followUps, total] = await Promise.all([
    FollowUp.find(filter)
      .populate('leadId', 'name phone email city leadScore status')
      .sort({ nextFollowUpDate: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    FollowUp.countDocuments(filter),
  ]);
  const leadIds = followUps.map((item) => item.leadId?._id).filter(Boolean);
  const conversations = leadIds.length
    ? await Conversation.find({ ownerId, leadId: { $in: leadIds } })
        .select('leadId aiSummary currentLeadScore lastIntent lastSentiment status lastMessageAt')
        .lean()
    : [];
  const conversationMap = new Map(conversations.map((item) => [String(item.leadId), item]));
  const enriched = followUps.map((item) => ({
    ...item,
    conversation: item.leadId ? (conversationMap.get(String(item.leadId._id)) || null) : null,
    leadTemperature: item.leadId?.status === 'hot' || Number(item.buyingProbability || 0) >= 70 ? 'hot'
      : item.leadId?.status === 'cold' || Number(item.buyingProbability || 0) <= 30 ? 'cold' : 'warm',
  }));

  return new ApiResponse(200, {
    followUps: enriched,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  }).send(res);
});

/** PATCH /api/followups/:id — mark done/skipped, or manually adjust date/message. */
const updateFollowUp = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const followUp = await FollowUp.findOneAndUpdate(
    { _id: req.params.id, ownerId },
    { $set: req.body },
    { new: true, runValidators: true }
  );
  if (!followUp) throw ApiError.notFound('Follow-up not found');
  return new ApiResponse(200, { followUp }, 'Follow-up updated').send(res);
});

/** DELETE /api/followups/:id — permanently removes a follow-up from the queue. */
const deleteFollowUp = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const followUp = await FollowUp.findOneAndDelete({ _id: req.params.id, ownerId });
  if (!followUp) throw ApiError.notFound('Follow-up not found');
  return new ApiResponse(200, null, 'Follow-up deleted').send(res);
});

/** POST /api/followups/:id/send — pending follow-up abhi WhatsApp par bhej do (message edit karke bhi). */
const sendFollowUp = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const followUp = await FollowUp.findOne({ _id: req.params.id, ownerId });
  if (!followUp) throw ApiError.notFound('Follow-up not found');
  if (followUp.status !== 'pending') throw ApiError.badRequest('Ye follow-up pending nahi hai');
  try {
    const result = await require('../services/followups/followUpAutomation').sendFollowUpNow(followUp, { text: req.body?.text });
    return new ApiResponse(200, result, 'Follow-up bhej diya').send(res);
  } catch (err) {
    followUp.lastError = String(err.message).slice(0, 300);
    await followUp.save();
    throw ApiError.badRequest(err.message);
  }
});

/**
 * POST /api/followups/lead/:id  { text?, date?, sendNow? }
 * Manual follow-up for one lead (e.g. a customer who said "no" to the
 * template). sendNow=true sends immediately, otherwise it is scheduled and
 * the automation sends it on the date (auto mode) or reminds you.
 */
const createForLead = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const Lead = require('../models/Lead');
  const lead = await Lead.findOne({ _id: req.params.id, ownerId });
  if (!lead) throw ApiError.notFound('Lead not found');
  if (lead.optedOut) throw ApiError.badRequest('Customer ne STOP likh kar messages band karwaye hain — unhe message nahi bhej sakte.');
  const automation = require('../services/followups/followUpAutomation');
  const settings = await require('../services/settings/settingsService').getOrCreateSettings();
  const cfg = automation.config(settings);
  const text = String(req.body?.text || '').trim() || automation.reengageText(cfg, lead, 1);
  const when = req.body?.date ? new Date(req.body.date) : new Date();
  if (Number.isNaN(when.getTime())) throw ApiError.badRequest('Date sahi nahi hai');
  await FollowUp.updateMany({ leadId: lead._id, status: 'pending', kind: { $in: ['manual', 'reengage'] } }, { $set: { status: 'skipped' } });
  const followUp = await FollowUp.create({
    leadId: lead._id,
    ownerId,
    kind: 'manual',
    nextFollowUpDate: when,
    nextFollowUpMessage: text,
    urgency: 'medium',
    generatedBy: 'manual',
  });
  if (req.body?.sendNow) {
    try {
      const result = await automation.sendFollowUpNow(followUp, { text });
      return new ApiResponse(201, { followUp, ...result }, 'Follow-up bhej diya').send(res);
    } catch (err) {
      followUp.lastError = String(err.message).slice(0, 300);
      await followUp.save();
      throw ApiError.badRequest(err.message);
    }
  }
  return new ApiResponse(201, { followUp }, 'Follow-up schedule ho gaya').send(res);
});

module.exports = { listFollowUps, updateFollowUp, deleteFollowUp, sendFollowUp, createForLead };
