const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const Meeting = require('../models/Meeting');
const Lead = require('../models/Lead');
const Conversation = require('../models/Conversation');
const { updateCalendarEvent, deleteCalendarEvent } = require('../services/calendar/googleCalendarService');
const logger = require('../utils/logger');

function scopeOwnerId(req) {
  if (req.user.role === 'admin' && req.query.ownerId) return req.query.ownerId;
  return req.user.id;
}

/** GET /api/meetings — Site Visits dashboard/list, filterable by status and date range. */
const listMeetings = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const { status, from, to, page, limit, source, when } = req.query;

  const filter = { ownerId };
  if (status) filter.status = status;
  if (source) filter.source = source;
  if (from || to) {
    filter.preferredDate = {};
    if (from) filter.preferredDate.$gte = from;
    if (to) filter.preferredDate.$lte = to;
  }
  // Today / upcoming / past, by India date (visits are stored as YYYY-MM-DD).
  const todayIST = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  if (when === 'today') filter.preferredDate = todayIST;
  if (when === 'upcoming') filter.preferredDate = { $gte: todayIST };
  if (when === 'past') filter.preferredDate = { $lt: todayIST };

  const summaryFilter = { ownerId };
  if (source) summaryFilter.source = source;
  if (from || to) {
    summaryFilter.preferredDate = {};
    if (from) summaryFilter.preferredDate.$gte = from;
    if (to) summaryFilter.preferredDate.$lte = to;
  }

  const [meetings, total, scheduled, visited, notVisited, rescheduled, cancelled] = await Promise.all([
    Meeting.find(filter)
      .populate('leadId', 'name phone email city status')
      .populate('propertyId', 'projectName city')
      .sort({ preferredDate: 1, preferredTime: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Meeting.countDocuments(filter),
    Meeting.countDocuments({ ...summaryFilter, status: 'scheduled' }),
    Meeting.countDocuments({ ...summaryFilter, status: 'visited' }),
    Meeting.countDocuments({ ...summaryFilter, status: 'not_visited' }),
    Meeting.countDocuments({ ...summaryFilter, status: 'rescheduled' }),
    Meeting.countDocuments({ ...summaryFilter, status: 'cancelled' }),
  ]);

  // Link each visit to its WhatsApp chat so the broker can open it in one click.
  const visitLeadIds = meetings.map((m) => m.leadId?._id).filter(Boolean);
  const conversations = visitLeadIds.length
    ? await Conversation.find({ ownerId, leadId: { $in: visitLeadIds } }).select('_id leadId aiSummary').lean()
    : [];
  const conversationByLead = new Map(conversations.map((c) => [String(c.leadId), c]));
  meetings.forEach((m) => {
    const conversation = m.leadId ? conversationByLead.get(String(m.leadId._id)) : null;
    m.conversationId = m.conversationId || conversation?._id || null;
    m.chatSummary = conversation?.aiSummary || '';
  });
  const [todayCount, upcomingCount, chatBooked] = await Promise.all([
    Meeting.countDocuments({ ...summaryFilter, preferredDate: todayIST, status: { $in: ['scheduled', 'rescheduled'] } }),
    Meeting.countDocuments({ ...summaryFilter, preferredDate: { $gte: todayIST }, status: { $in: ['scheduled', 'rescheduled'] } }),
    Meeting.countDocuments({ ownerId, source: 'whatsapp_ai' }),
  ]);

  const summary = {
    today: todayCount,
    upcoming: upcomingCount,
    chatBooked,
    total: scheduled + visited + notVisited + rescheduled + cancelled,
    scheduled,
    visited,
    notVisited,
    rescheduled,
    cancelled,
  };

  return new ApiResponse(200, {
    meetings,
    summary,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  }).send(res);
});

/** POST /api/meetings — manual creation by a broker (AI creates these automatically too). */
const createMeeting = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const { leadId, propertyId, preferredDate, preferredTime, notes } = req.body;

  const lead = await Lead.findOne({ _id: leadId, ownerId });
  if (!lead) throw ApiError.notFound('Lead not found');

  const meeting = await Meeting.create({ leadId, ownerId, propertyId, preferredDate, preferredTime, notes, source: 'manual' });

  await Lead.updateOne({ _id: leadId }, { $set: { status: 'site_visit' } });
  await Conversation.updateOne({ leadId }, { $set: { meetingStatus: 'scheduled' } });

  return new ApiResponse(201, { meeting }, 'Site visit scheduled').send(res);
});

/** PATCH /api/meetings/:id — update status (visited / not_visited / rescheduled / cancelled), date/time, notes. */
const updateMeeting = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const update = { ...req.body };
  // Date/time badli to confirmation dobara puchni padegi
  if (req.body.preferredDate || req.body.preferredTime) update['confirmation.status'] = 'none';
  const meeting = await Meeting.findOneAndUpdate(
    { _id: req.params.id, ownerId },
    { $set: update },
    { new: true, runValidators: true }
  );
  if (!meeting) throw ApiError.notFound('Meeting not found');

  // Keep the Google Calendar event in sync with reschedules/cancellations.
  if (meeting.googleEventId) {
    try {
      if (req.body.status === 'cancelled') {
        await deleteCalendarEvent(meeting.googleEventId);
        meeting.googleEventId = null;
        meeting.googleEventLink = null;
        await meeting.save();
      } else if (req.body.preferredDate || req.body.preferredTime) {
        await updateCalendarEvent({
          eventId: meeting.googleEventId,
          date: meeting.preferredDate,
          time: meeting.preferredTime,
        });
      }
    } catch (err) {
      logger.error(`[calendar] Failed to sync Google Calendar event for meeting ${meeting._id}`, { error: err.message });
    }
  }

  if (req.body.status) {
    const meetingToLeadStatus = { visited: 'closed', not_visited: 'warm', cancelled: 'warm' };
    const conversationMeetingStatus = { scheduled: 'scheduled', visited: 'visited', not_visited: 'not_visited', cancelled: 'cancelled', rescheduled: 'proposed' };
    await Conversation.updateOne({ leadId: meeting.leadId }, { $set: { meetingStatus: conversationMeetingStatus[req.body.status] || 'none' } });
    // "visited" is a strong buying signal but not an automatic close — only nudge status
    // when the lead hasn't already been manually closed/lost by the broker.
    if (meetingToLeadStatus[req.body.status] && req.body.status !== 'visited') {
      await Lead.updateOne(
        { _id: meeting.leadId, status: { $nin: ['closed', 'lost'] } },
        { $set: { status: meetingToLeadStatus[req.body.status] } }
      );
    }
  }

  return new ApiResponse(200, { meeting }, 'Site visit updated').send(res);
});

/** DELETE /api/meetings/:id */
const deleteMeeting = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const meeting = await Meeting.findOneAndDelete({ _id: req.params.id, ownerId });
  if (!meeting) throw ApiError.notFound('Meeting not found');

  if (meeting.googleEventId) {
    deleteCalendarEvent(meeting.googleEventId).catch((err) =>
      logger.error(`[calendar] Failed to delete Google Calendar event for meeting ${meeting._id}`, { error: err.message })
    );
  }

  return new ApiResponse(200, null, 'Site visit deleted').send(res);
});

/** POST /api/meetings/:id/send-confirmation — abhi WhatsApp confirmation bhejein. */
const sendConfirmation = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const meeting = await Meeting.findOne({ _id: req.params.id, ownerId }).select('_id');
  if (!meeting) throw ApiError.notFound('Meeting not found');
  try {
    await require('../services/visits/visitConfirmation').sendConfirmation(meeting._id, { force: true });
  } catch (err) {
    throw ApiError.badRequest(String(err.metaError?.message || err.message || 'Confirmation nahi gaya').slice(0, 250));
  }
  const fresh = await Meeting.findById(meeting._id).lean();
  return new ApiResponse(200, { meeting: fresh }, 'Confirmation WhatsApp par bhej diya').send(res);
});

/** POST /api/meetings/:id/call-confirmation — AI call se confirm karwayein. */
const callConfirmation = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const meeting = await Meeting.findOne({ _id: req.params.id, ownerId }).select('_id');
  if (!meeting) throw ApiError.notFound('Meeting not found');
  const base = (process.env.PUBLIC_API_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '').replace(/\/api$/, '');
  try {
    await require('../services/visits/visitConfirmation').callConfirmation(meeting._id, { publicBase: base });
  } catch (err) {
    throw err.statusCode ? err : ApiError.badRequest(String(err.message || 'Call nahi laga').slice(0, 250));
  }
  const fresh = await Meeting.findById(meeting._id).lean();
  return new ApiResponse(200, { meeting: fresh }, 'AI call lag rahi hai').send(res);
});

/** GET /api/meetings/confirmation-stats?days=30 — numbers for the Visit confirmation page. */
const confirmationStats = asyncHandler(async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  const stats = await require('../services/visits/visitConfirmation').stats({ days });
  return new ApiResponse(200, { stats }).send(res);
});

/** POST /api/meetings/:id/mark-confirmed { status: 'confirmed'|'declined' } — broker confirms by hand. */
const markConfirmation = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const status = req.body?.status === 'declined' ? 'declined' : 'confirmed';
  const meeting = await Meeting.findOneAndUpdate(
    { _id: req.params.id, ownerId },
    { $set: { 'confirmation.status': status, 'confirmation.repliedAt': new Date(), 'confirmation.confirmedVia': 'manual' } },
    { new: true },
  ).lean();
  if (!meeting) throw ApiError.notFound('Meeting not found');
  return new ApiResponse(200, { meeting }, status === 'confirmed' ? 'Visit confirmed' : 'Visit marked as not coming').send(res);
});

module.exports = { listMeetings, createMeeting, updateMeeting, deleteMeeting, sendConfirmation, callConfirmation, confirmationStats, markConfirmation };
