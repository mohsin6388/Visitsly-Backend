const asyncHandler = require('../utils/asyncHandler');
const ApiResponse = require('../utils/ApiResponse');
const Lead = require('../models/Lead');
const Property = require('../models/Property');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Meeting = require('../models/Meeting');
const FollowUp = require('../models/FollowUp');
const Analytics = require('../models/Analytics');
const EmailMessage = require('../models/EmailMessage');
const mongoose = require('mongoose');

/**
 * Scoping helper shared across analytics endpoints:
 * - broker/builder always see their own data
 * - admin sees everything, or a single owner's data via ?ownerId=
 */
function scopeOwnerId(req) {
  if (req.user.role === 'admin' && req.query.ownerId) return req.query.ownerId;
  if (req.user.role === 'admin') return null; // null => no ownerId filter (all owners)
  return req.user.id;
}

function ownerFilter(req) {
  const ownerId = scopeOwnerId(req);
  return ownerId ? { ownerId: new mongoose.Types.ObjectId(ownerId) } : {};
}

function startOfDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** GET /api/analytics/dashboard — all headline dashboard cards + recent activity in one call. */
const getDashboardSummary = asyncHandler(async (req, res) => {
  const filter = ownerFilter(req);
  const today = startOfDay();

  // Message doesn't carry ownerId directly, so scope it via the lead ids
  // that belong to this owner (skipped entirely for admin/no-filter view).
  let leadIdFilter = {};
  if (filter.ownerId) {
    const ownedLeadIds = await Lead.find(filter).distinct('_id');
    leadIdFilter = { leadId: { $in: ownedLeadIds } };
  }

  const [
    totalLeads,
    todaysUploads,
    activeConversations,
    messagesSent,
    repliesReceived,
    emailMessagesSent,
    emailRepliesReceived,
    hotLeads,
    warmLeads,
    coldLeads,
    siteVisitsScheduled,
    siteVisitsCompleted,
    dealsClosed,
    lostLeads,
    pendingFollowUps,
    recentUploads,
    latestConversations,
  ] = await Promise.all([
    Lead.countDocuments(filter),
    Lead.countDocuments({ ...filter, createdAt: { $gte: today } }),
    Conversation.countDocuments({ ...filter, status: { $in: ['ai_active', 'manual'] } }),
    Message.countDocuments({ ...leadIdFilter, direction: 'outbound', sender: { $in: ['ai', 'broker'] }, status: { $in: ['sent', 'delivered', 'read'] } }),
    Message.countDocuments({ ...leadIdFilter, direction: 'inbound', sender: 'customer' }),
    EmailMessage.countDocuments({ ...filter, direction: 'outbound', status: { $in: ['sent', 'delivered', 'delivery_delayed'] }, kind: { $in: ['campaign', 'reply'] } }),
    EmailMessage.countDocuments({ ...filter, direction: 'inbound', kind: 'received' }),
    Lead.countDocuments({ ...filter, status: 'hot' }),
    Lead.countDocuments({ ...filter, status: 'warm' }),
    Lead.countDocuments({ ...filter, status: 'cold' }),
    Meeting.countDocuments({ ...filter, status: 'scheduled' }),
    Meeting.countDocuments({ ...filter, status: 'visited' }),
    Lead.countDocuments({ ...filter, status: 'closed' }),
    Lead.countDocuments({ ...filter, status: 'lost' }),
    FollowUp.countDocuments({ ...filter, status: 'pending' }),
    Lead.find(filter).sort({ createdAt: -1 }).limit(8).select('name phone city status createdAt'),
    Conversation.find(filter)
      .sort({ lastMessageAt: -1 })
      .limit(8)
      .populate('leadId', 'name phone')
      .select('leadId status lastMessageAt currentLeadScore aiSummary'),
  ]);

  const closedOrLost = dealsClosed + lostLeads;
  const conversionRate = totalLeads > 0 ? Number(((dealsClosed / totalLeads) * 100).toFixed(2)) : 0;

  return new ApiResponse(200, {
    cards: {
      totalLeads,
      todaysUploads,
      activeConversations,
      messagesSent: messagesSent + emailMessagesSent,
      repliesReceived: repliesReceived + emailRepliesReceived,
      hotLeads,
      warmLeads,
      coldLeads,
      interestedBuyers: hotLeads + warmLeads,
      notInterestedBuyers: lostLeads,
      siteVisitsScheduled,
      siteVisitsCompleted,
      dealsClosed,
      pendingFollowUps,
      conversionRate,
    },
    recentActivity: {
      recentUploads,
      latestConversations,
    },
  }, 'Dashboard summary fetched').send(res);
});

/** GET /api/analytics/timeseries — live daily activity for the dashboard. */
const getTimeseries = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const range = ['7d', '30d', 'previous_month'].includes(req.query.range) ? req.query.range : '7d';
  const timeZone = 'Asia/Kolkata';
  const dateInZone = (date) => new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
  const today = dateInZone(new Date());
  const toUtcDay = (iso) => new Date(`${iso}T00:00:00+05:30`);
  const addDays = (iso, amount) => {
    const d = new Date(`${iso}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + amount);
    return d.toISOString().slice(0, 10);
  };
  let fromStr = today;
  let toStr = today;
  if (range === '7d') fromStr = addDays(today, -6);
  if (range === '30d') fromStr = addDays(today, -29);
  if (range === 'previous_month') {
    const currentMonth = new Date(`${today.slice(0, 7)}-01T12:00:00Z`);
    currentMonth.setUTCMonth(currentMonth.getUTCMonth() - 1);
    fromStr = currentMonth.toISOString().slice(0, 7) + '-01';
    const nextMonth = new Date(`${today.slice(0, 7)}-01T12:00:00Z`);
    toStr = addDays(nextMonth.toISOString().slice(0, 10), -1);
  }
  const from = toUtcDay(fromStr);
  const toExclusive = toUtcDay(addDays(toStr, 1));
  const ownedLeadIds = ownerId ? await Lead.find({ ownerId }).distinct('_id') : null;
  const messageMatch = {
    timestamp: { $gte: from, $lt: toExclusive },
    ...(ownedLeadIds ? { leadId: { $in: ownedLeadIds } } : {}),
  };
  const emailMatch = {
    ownerId: ownerId ? new mongoose.Types.ObjectId(ownerId) : { $exists: true },
    direction: { $in: ['outbound', 'inbound'] },
  };
  const [whatsappRows, emailRows] = await Promise.all([
    Message.aggregate([
      { $match: messageMatch },
      { $match: { $or: [
        { direction: 'outbound', sender: { $in: ['ai', 'broker'] }, status: { $in: ['sent', 'delivered', 'read'] } },
        { direction: 'inbound', sender: 'customer' },
      ] } },
      { $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp', timezone: timeZone } },
        messagesSent: { $sum: { $cond: [{ $eq: ['$direction', 'outbound'] }, 1, 0] } },
        repliesReceived: { $sum: { $cond: [{ $eq: ['$direction', 'inbound'] }, 1, 0] } },
      } },
    ]),
    EmailMessage.aggregate([
      { $match: emailMatch },
      { $addFields: { metricAt: { $cond: [
        { $eq: ['$direction', 'outbound'] }, { $ifNull: ['$sentAt', '$createdAt'] }, { $ifNull: ['$receivedAt', '$createdAt'] },
      ] } } },
      { $match: { metricAt: { $gte: from, $lt: toExclusive }, $or: [
        { direction: 'outbound', status: { $in: ['sent', 'delivered', 'delivery_delayed'] }, kind: { $in: ['campaign', 'reply'] } },
        { direction: 'inbound', kind: 'received' },
      ] } },
      { $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$metricAt', timezone: timeZone } },
        messagesSent: { $sum: { $cond: [{ $eq: ['$direction', 'outbound'] }, 1, 0] } },
        repliesReceived: { $sum: { $cond: [{ $eq: ['$direction', 'inbound'] }, 1, 0] } },
      } },
    ]),
  ]);
  const buckets = new Map();
  for (let date = fromStr; date <= toStr; date = addDays(date, 1)) buckets.set(date, { date, period: range === 'previous_month' ? date.slice(8, 10) : date.slice(5, 10), messagesSent: 0, repliesReceived: 0 });
  for (const row of [...whatsappRows, ...emailRows]) {
    const bucket = buckets.get(row._id);
    if (bucket) {
      bucket.messagesSent += row.messagesSent || 0;
      bucket.repliesReceived += row.repliesReceived || 0;
    }
  }
  const series = [...buckets.values()].map((bucket) => ({
    ...bucket,
    period: new Intl.DateTimeFormat('en-IN', { timeZone, day: '2-digit', month: 'short' }).format(new Date(`${bucket.date}T12:00:00Z`)),
  }));
  return new ApiResponse(200, { range, from: fromStr, to: toStr, series }, 'Timeseries fetched').send(res);
});

/** GET /api/analytics/funnel — Sales Funnel + Site Visit Funnel. */
const getFunnel = asyncHandler(async (req, res) => {
  const filter = ownerFilter(req);

  const [byStatus, meetingsByStatus] = await Promise.all([
    Lead.aggregate([{ $match: filter }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    Meeting.aggregate([{ $match: filter }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
  ]);

  const statusMap = Object.fromEntries(byStatus.map((s) => [s._id, s.count]));
  const meetingMap = Object.fromEntries(meetingsByStatus.map((s) => [s._id, s.count]));

  const salesFunnel = [
    { stage: 'New', count: statusMap.new || 0 },
    { stage: 'Contacted', count: statusMap.contacted || 0 },
    { stage: 'Qualified', count: statusMap.qualified || 0 },
    { stage: 'Hot', count: statusMap.hot || 0 },
    { stage: 'Site Visit', count: statusMap.site_visit || 0 },
    { stage: 'Closed', count: statusMap.closed || 0 },
  ];

  const siteVisitFunnel = [
    { stage: 'Scheduled', count: meetingMap.scheduled || 0 },
    { stage: 'Visited', count: meetingMap.visited || 0 },
    { stage: 'Not Visited', count: meetingMap.not_visited || 0 },
    { stage: 'Rescheduled', count: meetingMap.rescheduled || 0 },
    { stage: 'Cancelled', count: meetingMap.cancelled || 0 },
  ];

  return new ApiResponse(200, { salesFunnel, siteVisitFunnel }, 'Funnel data fetched').send(res);
});

/** GET /api/analytics/lead-sources — breakdown of leads by source, for pie/bar chart. */
const getLeadSources = asyncHandler(async (req, res) => {
  const filter = ownerFilter(req);
  const rows = await Lead.aggregate([
    { $match: filter },
    { $group: { _id: '$source', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);
  return new ApiResponse(200, rows.map((r) => ({ source: r._id || 'unknown', count: r.count })), 'Lead sources fetched').send(res);
});

/** GET /api/analytics/property-performance — top performing properties by recommendation + closing count. */
const getPropertyPerformance = asyncHandler(async (req, res) => {
  const filter = ownerFilter(req);

  const rows = await Conversation.aggregate([
    { $match: { recommendedProperties: { $exists: true, $ne: [] } } },
    { $unwind: '$recommendedProperties' },
    {
      $group: {
        _id: '$recommendedProperties',
        recommendedCount: { $sum: 1 },
        closedCount: {
          $sum: { $cond: [{ $eq: ['$meetingStatus', 'visited'] }, 1, 0] },
        },
      },
    },
    { $sort: { recommendedCount: -1 } },
    { $limit: 10 },
    {
      $lookup: {
        from: 'properties',
        localField: '_id',
        foreignField: '_id',
        as: 'property',
      },
    },
    { $unwind: '$property' },
    ...(Object.keys(filter).length ? [{ $match: { 'property.ownerId': filter.ownerId } }] : []),
    {
      $project: {
        _id: 0,
        propertyId: '$_id',
        projectName: '$property.projectName',
        city: '$property.city',
        recommendedCount: 1,
        closedCount: 1,
      },
    },
  ]);

  return new ApiResponse(200, rows, 'Property performance fetched').send(res);
});

/**
 * GET /api/analytics/source-performance?days=30
 * Overview card: leads per channel (Facebook/Instagram ads, Google Ads,
 * 99acres, MagicBricks, Housing, website, WhatsApp direct …) with how many
 * turned hot, booked a visit and closed.
 */
const SOURCE_GROUPS = {
  facebook_ads: 'facebook', instagram_ads: 'facebook', facebook: 'facebook', meta_lead_ads: 'facebook',
  google_ads: 'google',
  '99acres': '99acres', magicbricks: 'magicbricks', housing: 'housing', nobroker: 'nobroker', squareyards: 'other_portals', commonfloor: 'other_portals', email_lead: 'other_portals',
  website_form: 'website', hosted_form: 'website',
  whatsapp_inbound: 'whatsapp',
  channel_partner: 'channel_partner',
  voice_ai: 'other', whatsapp_ai: 'other',
};
const groupOf = (src) => {
  const s = String(src || 'manual');
  if (SOURCE_GROUPS[s]) return SOURCE_GROUPS[s];
  if (/^(file_import|csv_import|bulk_sheet_upload|bulk_paste)/.test(s)) return 'upload';
  if (s === 'manual') return 'manual';
  return 'other';
};

const getSourcePerformance = asyncHandler(async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  const since = new Date(Date.now() - days * 86400000);
  const todayStart = new Date(new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10) + 'T00:00:00+05:30');
  const rows = await Lead.aggregate([
    { $match: { ...ownerFilter(req), createdAt: { $gte: since } } },
    {
      $group: {
        _id: '$source',
        total: { $sum: 1 },
        today: { $sum: { $cond: [{ $gte: ['$createdAt', todayStart] }, 1, 0] } },
        hot: { $sum: { $cond: [{ $eq: ['$status', 'hot'] }, 1, 0] } },
        warm: { $sum: { $cond: [{ $eq: ['$status', 'warm'] }, 1, 0] } },
        siteVisit: { $sum: { $cond: [{ $eq: ['$status', 'site_visit'] }, 1, 0] } },
        closed: { $sum: { $cond: [{ $or: [{ $eq: ['$status', 'closed'] }, { $ne: ['$bookedAt', null] }] }, 1, 0] } },
        lastAt: { $max: '$createdAt' },
      },
    },
  ]);
  const groups = new Map();
  for (const r of rows) {
    const g = groupOf(r._id);
    if (!groups.has(g)) groups.set(g, { key: g, sources: [], total: 0, today: 0, hot: 0, warm: 0, siteVisit: 0, closed: 0, lastAt: null });
    const x = groups.get(g);
    x.sources.push(r._id || 'manual');
    for (const k of ['total', 'today', 'hot', 'warm', 'siteVisit', 'closed']) x[k] += r[k];
    if (!x.lastAt || r.lastAt > x.lastAt) x.lastAt = r.lastAt;
  }
  const list = [...groups.values()].sort((a, b) => b.total - a.total);
  const totals = list.reduce((acc, x) => {
    for (const k of ['total', 'today', 'hot', 'warm', 'siteVisit', 'closed']) acc[k] = (acc[k] || 0) + x[k];
    return acc;
  }, {});
  return new ApiResponse(200, { days, sources: list, totals }).send(res);
});

module.exports = {
  getSourcePerformance,
  getDashboardSummary,
  getTimeseries,
  getFunnel,
  getLeadSources,
  getPropertyPerformance,
};
