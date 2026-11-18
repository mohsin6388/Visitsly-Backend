const { Parser: CsvParser } = require("json2csv");
const mongoose = require("mongoose");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");
const ApiResponse = require("../utils/ApiResponse");
const Lead = require("../models/Lead");
const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const EmailMessage = require("../models/EmailMessage");
const OutboundJob = require("../models/OutboundJob");
const Meeting = require("../models/Meeting");
const AuditLog = require("../models/AuditLog");
const {
  parseCsvBuffer,
  parseExcelBuffer,
  parseLeadText,
  analyzeRows,
} = require("../services/csv/leadImporter");
const { importLeadRows } = require("../services/leads/leadImportService");
const { normalizePhone, isValidEmail, phoneVariants } = require("../utils/phone");
// Company's country decides how ambiguous local numbers are read (IN default; UAE 05x / 5x numbers are always detected).
const phoneOpts = (req) => ({ defaultCountry: String(req.org?.country || "IN").toUpperCase() });
const { enqueueLeads } = require("../services/queue/outboundQueue");

/**
 * Scoping helper: brokers only ever see/act on their own leads.
 * Admins can pass ?ownerId= to view a specific broker's leads; builders
 * don't own leads at all (they view leads via property-match reporting,
 * not this resource) — enforced in the route via roleGuard.
 */
function scopeToOwner(req) {
  if (req.user.role === "admin" && req.query.ownerId) {
    return { ownerId: req.query.ownerId };
  }
  // SaaS lead routing: agents can be limited to the leads assigned to them.
  if (req.user.orgRole === "agent" && req.org?.routing?.agentsSeeOnlyAssigned) {
    return { ownerId: req.user.id, assignedTo: req.user.actorId };
  }
  if (req.query.assignedTo === "me") return { ownerId: req.user.id, assignedTo: req.user.actorId };
  if (req.query.assignedTo === "none") return { ownerId: req.user.id, assignedTo: null };
  if (/^[a-f\d]{24}$/i.test(String(req.query.assignedTo || ""))) return { ownerId: req.user.id, assignedTo: req.query.assignedTo };
  return { ownerId: req.user.id };
}

const { LEAD_SCORE, HOT_SCORE, leadTypeFor } = require("../config/leadRules");

const AUTO_REPLY_PATTERN = /(automatic reply|auto.?reply|out of office|do not reply|no.?reply|i am an ai|virtual assistant|leave a message|not monitored|on leave until)/i;

/**
 * Who has genuinely replied, and who has a site visit. A human-looking reply
 * counts at once; if every message looks like an auto-responder it only
 * counts after 3 of them (so an out-of-office mail is not a buyer).
 */
async function getQualificationSets(req, replyChannel = "") {
  const ownerFilter = scopeToOwner(req);
  const ownedIds = await Lead.find(ownerFilter).distinct("_id");
  const owned = new Set(ownedIds.map(String));
  const repliedIds = new Set();

  if (replyChannel !== "whatsapp") {
    const emailReplyIds = await EmailMessage.distinct("leadId", { ...ownerFilter, direction: "inbound", kind: "received", leadId: { $ne: null } });
    emailReplyIds.filter(Boolean).forEach((id) => { if (owned.has(String(id))) repliedIds.add(String(id)); });
  }
  if (replyChannel !== "email") {
    // One grouped query instead of loading every inbound message into memory.
    const grouped = await Message.aggregate([
      { $match: { leadId: { $in: ownedIds }, direction: "inbound", sender: "customer" } },
      { $group: {
        _id: "$leadId",
        auto: { $sum: { $cond: [{ $regexMatch: { input: { $ifNull: ["$text", ""] }, regex: AUTO_REPLY_PATTERN.source, options: "i" } }, 1, 0] } },
        total: { $sum: 1 },
      } },
    ]);
    for (const item of grouped) {
      const human = item.total - item.auto;
      if (human >= 1 || item.auto >= 3) repliedIds.add(String(item._id));
    }
  }

  const meetingOwner = ownerFilter.ownerId;
  const visitLeadIds = await Meeting.distinct("leadId", { ownerId: meetingOwner, status: { $ne: "cancelled" } });
  const visitIds = new Set(visitLeadIds.map(String).filter((id) => owned.has(id)));
  return { repliedIds: [...repliedIds], visitIds: [...visitIds] };
}

function buildStageClause(stage, { repliedIds, visitIds, replyChannel }) {
  const replied = { _id: { $in: repliedIds } };
  const visit = { $or: [{ _id: { $in: visitIds } }, { status: "site_visit" }] };
  // A channel view (WhatsApp → Leads) only shows people who replied on that channel.
  const channelGuard = replyChannel ? [replied] : [];
  if (stage === "hot") return { $and: [replied, { leadScore: { $gt: HOT_SCORE } }] };
  if (stage === "visit") return { $and: [visit, ...channelGuard] };
  return { $and: [{ $or: [{ $and: [replied, { leadScore: { $gt: LEAD_SCORE } }] }, visit] }, ...channelGuard] };
}

/**
 * POST /api/leads/import/preview
 * Upload a CSV, get back every row annotated as valid/invalid/duplicate.
 * Nothing is written to the DB at this step.
 */
const previewImport = asyncHandler(async (req, res) => {
  if (!req.file)
    throw ApiError.badRequest('CSV file is required (field name: "file")');

  const opts = phoneOpts(req);
  let rows;
  try {
    const filename = String(req.file.originalname || "").toLowerCase();
    const buf = req.file.buffer;
    // Detect by content too: a real .xlsx is a ZIP ("PK"), an old .xls starts with D0 CF 11 E0.
    const isZip = buf.length > 3 && buf[0] === 0x50 && buf[1] === 0x4b;
    const isOldXls = buf.length > 3 && buf.readUInt32BE(0) === 0xd0cf11e0;
    rows = filename.endsWith(".xlsx") || filename.endsWith(".xlsm") || isZip || isOldXls ? parseExcelBuffer(buf, opts) : parseCsvBuffer(buf, opts);
  } catch (err) {
    throw ApiError.badRequest(err.message);
  }

  const channel = ["whatsapp", "email"].includes(String(req.query.channel || "")) ? String(req.query.channel) : "both";
  const { rows: analyzed, summary } = await analyzeRows(req.user.id, rows, channel, opts);

  return new ApiResponse(200, { rows: analyzed, summary }, "CSV parsed").send(
    res,
  );
});

/**
 * POST /api/leads/import/parse-text
 * Body: { text } — har line mein name + phone (+ email) kisi bhi order mein.
 * Response CSV preview jaisa hi hai (valid / invalid / duplicate per row).
 */
const previewText = asyncHandler(async (req, res) => {
  const opts = phoneOpts(req);
  const rows = parseLeadText(req.body.text, opts);
  if (!rows.length) throw ApiError.badRequest("No leads found in the pasted text");

  const { rows: analyzed, summary } = await analyzeRows(req.user.id, rows, "both", opts);
  return new ApiResponse(200, { rows: analyzed, summary }, "Text parsed").send(
    res,
  );
});

/**
 * POST /api/leads/import/confirm
 * Client sends back the rows it wants imported (typically the "valid" subset
 * from the preview step, possibly after manual edits). Duplicate-safe via
 * insertMany({ ordered: false }) + the unique (ownerId, phone) index.
 */
const confirmImport = asyncHandler(async (req, res) => {
  const { rows } = req.body;
  const ownerId = req.user.id;

  const { inserted, skipped, existingIds = [], skippedByLimit = 0 } = await importLeadRows(ownerId, rows, phoneOpts(req));

  await AuditLog.create({
    userId: req.user.id,
    action: "lead.import",
    entityType: "Lead",
    meta: { insertedCount: inserted.length, skipped },
    ip: req.ip,
  });

  // Uploading data never sends a WhatsApp or email message. The user selects
  // contacts and starts a channel-specific campaign later from WhatsApp/Email.
  return new ApiResponse(
    201,
    { insertedCount: inserted.length, skipped, skippedByLimit, leadIds: inserted.map((lead) => lead._id), existingLeadIds: existingIds },
    `Imported ${inserted.length} leads${skipped - skippedByLimit ? `, skipped ${skipped - skippedByLimit} duplicates` : ""}${skippedByLimit ? `. ${skippedByLimit} contacts not added due to your plan limit — upgrade your plan` : ""}. No messages were sent.`,
  ).send(res);
});

/**
 * POST /api/leads/start-conversations
 * Body: { leadIds: [...] }
 * Kicks off the opening WhatsApp message for a batch of leads (typically
 * the leadIds just returned by /import/confirm, once the broker clicks
 * "Start") — or for any lead whose conversation hasn't been started yet.
 * Safe to call more than once: startConversation() no-ops for leads that
 * already have messages.
 */

const startConversations = asyncHandler(async (req, res) => {
  const { leadIds } = req.body;

  if (!Array.isArray(leadIds) || !leadIds.length) {
    throw ApiError.badRequest("leadIds is required");
  }

  const ownerId = req.user.id;

  // Only allow leads belonging to the logged-in broker.
  const leads = await Lead.find({
    _id: { $in: leadIds },
    ownerId,
    phone: { $type: "string" },
  }).select("_id");

  if (!leads.length) {
    throw ApiError.badRequest("No valid leads found");
  }

  const validLeadIds = leads.map((lead) => lead._id);

  // Only queue leads that have a conversation.
  const conversations = await Conversation.find({
    ownerId,
    leadId: { $in: validLeadIds },
  })
    .select("leadId")
    .lean();

  const leadIdsWithConversation = conversations.map(
    (conversation) => conversation.leadId,
  );

  const queueResult = await enqueueLeads({
    ownerId,
    leadIds: leadIdsWithConversation,
  });

  return new ApiResponse(
    200,
    {
      queued: queueResult.queued,
      skipped: queueResult.skipped,
      batchId: queueResult.batchId,
    },
    `Queued ${queueResult.queued} lead(s) for WhatsApp messaging`,
  ).send(res);
});

// const startConversations = asyncHandler(async (req, res) => {
//   const { leadIds } = req.body;
//   if (!Array.isArray(leadIds) || !leadIds.length) throw ApiError.badRequest('leadIds is required');

//   const ownerId = req.user.id;
//   const leads = await Lead.find({ _id: { $in: leadIds }, ownerId });
//   const leadById = new Map(leads.map((l) => [l._id.toString(), l]));

//   const conversations = await Conversation.find({ leadId: { $in: leads.map((l) => l._id) } });

//   let started = 0;
//   for (const conversation of conversations) {
//     const lead = leadById.get(conversation.leadId.toString());
//     if (!lead) continue;
//     started += 1;
//     conversationEngine.startConversation({ lead, conversation }).catch((err) =>
//       logger.error(`[leads] Failed to start WhatsApp conversation for lead ${lead._id}`, { error: err.message })
//     );
//   }

//   return new ApiResponse(200, { queued: started }, `Starting conversations for ${started} lead(s)`).send(res);
// });

/**
 * POST /api/leads
 */

const createLead = asyncHandler(async (req, res) => {
  let phone = null;
  const rawPhone = String(req.body.phone || "").trim();
  if (rawPhone) {
    const result = normalizePhone(rawPhone, phoneOpts(req));
    if (!result.ok) throw ApiError.badRequest(result.error || "Enter a valid mobile number");
    phone = result.phone;
  }
  const email = String(req.body.email || "").trim().toLowerCase() || undefined;
  if (email && !isValidEmail(email)) throw ApiError.badRequest("Invalid email format");
  if (!phone && !email) throw ApiError.badRequest("A mobile number or email is required");

  if (phone) {
    const existing = await Lead.findOne({ ownerId: req.user.id, phone: { $in: phoneVariants(phone) } }).select("name").lean();
    if (existing) throw ApiError.conflict(`This number is already saved${existing.name ? ` (${existing.name})` : ""}`);
  }
  if (email && await Lead.findOne({ ownerId: req.user.id, email })) {
    throw ApiError.conflict("This email is already saved");
  }

  require("../services/saas/subscription").assertWithinLimit("contacts", await Lead.countDocuments({ ownerId: req.user.id }), 1);

  const name = String(req.body.name || '').trim() ||
    (email ? email.split('@')[0].replace(/[._+-]+/g, ' ').trim() : `Lead ${String(phone || '').replace(/\D/g, '').slice(-4)}`) || 'New lead';
  const lead = await Lead.create({ ...req.body, name: name.slice(0, 150), phone, email, ownerId: req.user.id });
  if (phone) await Conversation.updateOne(
    { ownerId: lead.ownerId, leadId: lead._id },
    { $setOnInsert: { ownerId: lead.ownerId, leadId: lead._id } },
    { upsert: true },
  );

  return new ApiResponse(201, {
    lead,
    queued: 0,
    batchId: null,
    availableChannels: { whatsapp: Boolean(phone), email: Boolean(email) },
  }, "Lead saved. No message was sent; launch a campaign when ready.").send(res);
});

/**
 * GET /api/leads
 */
const listLeads = asyncHandler(async (req, res) => {
  const { page, limit, search, status, city, tag, sortBy, sortOrder, qualifiedOnly } =
    req.query;

  const filter = { ...scopeToOwner(req) };
  const idClauses = [];
  if (status) filter.status = status;
  const channel = ['whatsapp', 'email'].includes(String(req.query.channel || '')) ? String(req.query.channel) : '';
  const delivery = ['sent', 'unsent'].includes(String(req.query.delivery || '')) ? String(req.query.delivery) : '';
  if (channel === 'whatsapp') filter.phone = { $type: 'string', $ne: '' };
  if (channel === 'email') filter.email = { $type: 'string', $ne: '' };
  if (channel && delivery) {
    const sentLeadIds = await OutboundJob.distinct('leadId', { ownerId: req.user.id, channel, status: 'sent' });
    idClauses.push({ _id: delivery === 'sent' ? { $in: sentLeadIds } : { $nin: sentLeadIds } });
  }

  // Replied filter: ?replied=yes|no (channel ke hisaab se: WhatsApp / Email / dono)
  if (['yes', 'no'].includes(String(req.query.replied || ''))) {
    const { repliedIds: repliedList } = await getQualificationSets(req, channel);
    idClauses.push({ _id: req.query.replied === 'yes' ? { $in: repliedList } : { $nin: repliedList } });
  }

  // Audience / explicit selection: ?ids=a,b,c (used by bulk messaging to show
  // an audience's contacts). Only well-formed ids are accepted.
  if (req.query.ids) {
    const ids = String(req.query.ids).split(",").map((id) => id.trim()).filter((id) => /^[0-9a-fA-F]{24}$/.test(id));
    idClauses.push({ _id: { $in: ids } });
  }

  // Qualified Leads (and WhatsApp → Leads / Email → Leads):
  //   all   = replied + score > 30, or any lead with a booked site visit
  //   hot   = replied + score > 60
  //   visit = site visit booked (AI on WhatsApp, or added by the broker)
  const replyChannel = ['whatsapp', 'email'].includes(String(req.query.replyChannel || '')) ? String(req.query.replyChannel) : '';
  let qualifiedCounts = null;
  if (String(qualifiedOnly || "") === "1" || String(qualifiedOnly || "").toLowerCase() === "true") {
    const { repliedIds, visitIds } = await getQualificationSets(req, replyChannel);
    const stageClause = (name) => buildStageClause(name, { repliedIds, visitIds, replyChannel });
    idClauses.push(stageClause(['hot', 'visit'].includes(req.query.stage) ? req.query.stage : 'all'));
    const ownerOnly = scopeToOwner(req);
    const [all, hot, visit] = await Promise.all([
      Lead.countDocuments({ ...ownerOnly, ...stageClause('all') }),
      Lead.countDocuments({ ...ownerOnly, ...stageClause('hot') }),
      Lead.countDocuments({ ...ownerOnly, ...stageClause('visit') }),
    ]);
    qualifiedCounts = { all, hot, visit, leadScore: LEAD_SCORE, hotScore: HOT_SCORE };
  }
  if (idClauses.length) filter.$and = [...(filter.$and || []), ...idClauses];
  if (city) filter.city = new RegExp(`^${city}$`, "i");
  if (tag) filter.tags = tag;
  if (req.query.source) filter.source = String(req.query.source);
  if (req.query.file) filter.importFile = req.query.file === "__manual__" ? { $in: [null, ""] } : req.query.file;
  if (search) {
    const escaped = String(search).trim().slice(0, 120).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (escaped) {
      const re = new RegExp(escaped, 'i');
      filter.$or = [
        { name: re }, { email: re }, { phone: re }, { city: re },
        { address: re }, { jobTitle: re }, { notes: re }, { requirements: re },
      ];
    }
  }

  // _id as a tie-breaker keeps the order (and so the Sr. no.) stable between pages.
  const sort = { [sortBy]: sortOrder === "asc" ? 1 : -1, _id: sortOrder === "asc" ? 1 : -1 };

  // Contacts sheet: ordered ids only, for "select Sr. no. X to Y" across pages.
  if (["1", "true"].includes(String(req.query.idsOnly || ""))) {
    const rows = await Lead.find(filter).sort(sort).limit(20000).select("_id").lean();
    return new ApiResponse(200, { ids: rows.map((row) => row._id), total: rows.length }).send(res);
  }

  const ownerFilter = scopeToOwner(req);
  const nonEmpty = (field) => ({ $gt: [{ $strLenCP: { $ifNull: [`$${field}`, ""] } }, 0] });
  const count = (cond) => ({ $sum: { $cond: [cond, 1, 0] } });
  const ownerMatch = { ...ownerFilter };
  if (ownerMatch.ownerId) ownerMatch.ownerId = new mongoose.Types.ObjectId(String(ownerMatch.ownerId));
  if (ownerMatch.assignedTo) ownerMatch.assignedTo = new mongoose.Types.ObjectId(String(ownerMatch.assignedTo));

  // One grouped query for every stat card instead of nine separate counts.
  const [leads, total, [counts = {}], sources] = await Promise.all([
    Lead.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).lean(),
    Lead.countDocuments(filter),
    Lead.aggregate([
      { $match: ownerMatch },
      { $group: {
        _id: null,
        allLeads: { $sum: 1 },
        whatsappAvailable: count(nonEmpty("phone")),
        emailAvailable: count(nonEmpty("email")),
        bothAvailable: count({ $and: [nonEmpty("phone"), nonEmpty("email")] }),
        whatsappOnly: count({ $and: [nonEmpty("phone"), { $not: [nonEmpty("email")] }] }),
        emailOnly: count({ $and: [nonEmpty("email"), { $not: [nonEmpty("phone")] }] }),
        siteVisits: count({ $eq: ["$status", "site_visit"] }),
      } },
    ]),
    Lead.distinct("source", ownerFilter),
  ]);
  const { allLeads = 0, whatsappAvailable = 0, emailAvailable = 0, bothAvailable = 0, whatsappOnly = 0, emailOnly = 0, siteVisits = 0 } = counts;

  // conversationStarted lets the frontend show a "Start" button for any lead
  // that's been imported/created but whose opening WhatsApp message hasn't
  // gone out yet (see POST /leads/start-conversations).
  const pageLeadIds = leads.map((lead) => lead._id);
  const messageTime = { $ifNull: ["$timestamp", "$createdAt"] };
  const [conversations, outboundJobs, emailEvents, lastOutbound, inboundStats, visits] = await Promise.all([
    Conversation.find({ ownerId: req.user.id, leadId: { $in: pageLeadIds } }, "leadId lastMessageAt").lean(),
    OutboundJob.find({ ownerId: req.user.id, leadId: { $in: pageLeadIds } }).select("leadId channel status attempts campaignId sentAt").sort({ updatedAt: -1 }).lean(),
    EmailMessage.find({ ownerId: req.user.id, leadId: { $in: pageLeadIds } }).select("leadId direction kind status sentAt subject receivedAt createdAt").sort({ createdAt: -1 }).lean(),
    // Per-lead summaries computed in the database; the old code pulled every message into memory.
    Message.aggregate([
      { $match: { leadId: { $in: pageLeadIds }, direction: "outbound" } },
      { $sort: { timestamp: -1 } },
      { $group: { _id: "$leadId", sentAt: { $first: messageTime }, status: { $first: "$status" } } },
    ]),
    Message.aggregate([
      { $match: { leadId: { $in: pageLeadIds }, direction: "inbound", sender: "customer" } },
      { $group: { _id: "$leadId", replyCount: { $sum: 1 }, replyAt: { $max: messageTime } } },
    ]),
    Meeting.aggregate([
      { $match: { ownerId: req.user._id || req.user.id, leadId: { $in: pageLeadIds } } },
      { $sort: { preferredDate: -1, preferredTime: -1, updatedAt: -1 } },
      { $group: { _id: "$leadId", siteVisitCount: { $sum: 1 }, latestVisit: { $first: "$$ROOT" } } },
    ]),
  ]);
  const lastMessageByLead = new Map(conversations.map((c) => [String(c.leadId), c.lastMessageAt]));
  const outboundMessageLeadIds = new Set(lastOutbound.map((row) => String(row._id)));
  const channelStatus = new Map();
  for (const job of outboundJobs) {
    // A pre-created/no-attempt queue row is not a real send result. Legacy
    // non-campaign failures came from the old auto-start flow; don't label a
    // never-messaged contact as failed unless an outbound record exists.
    if (job.status !== 'sent' && !(Number(job.attempts || 0) > 0)) continue;
    if (job.channel === 'whatsapp' && job.status === 'failed' && !job.campaignId && !outboundMessageLeadIds.has(String(job.leadId))) continue;
    const key = String(job.leadId);
    if (!channelStatus.has(key)) channelStatus.set(key, {});
    const state = channelStatus.get(key);
    if (!state[job.channel]) state[job.channel] = job;
  }
  const emailState = new Map();
  for (const event of emailEvents) {
    const key = String(event.leadId);
    if (!emailState.has(key)) emailState.set(key, { sentAt: null, status: "not_sent", replyAt: null, replyCount: 0, subject: "" });
    const state = emailState.get(key);
    if (event.direction === "inbound" && event.kind === "received") {
      state.replyCount += 1;
      if (!state.replyAt) state.replyAt = event.receivedAt || event.createdAt;
    } else if (event.direction === "outbound" && event.kind === "campaign" && state.status === "not_sent") {
      state.status = event.status;
      state.sentAt = event.sentAt || null;
      state.subject = event.subject || "";
    }
  }
  const whatsappState = new Map();
  for (const row of lastOutbound) whatsappState.set(String(row._id), { sentAt: row.sentAt || null, sentStatus: row.status || "sent", replyAt: null, replyCount: 0 });
  for (const row of inboundStats) {
    const key = String(row._id);
    const state = whatsappState.get(key) || { sentAt: null, sentStatus: "not_sent" };
    whatsappState.set(key, { ...state, replyAt: row.replyAt || null, replyCount: row.replyCount || 0 });
  }
  const visitState = new Map(visits.map((row) => [String(row._id), row]));
  const leadsWithStatus = leads.map((lead) => {
    const key = String(lead._id);
    const wa = whatsappState.get(key) || {};
    const email = emailState.get(key) || {};
    const jobs = channelStatus.get(key) || {};
    const waJob = jobs.whatsapp;
    const emailJob = jobs.email;
    const visit = visitState.get(key);
    return {
      ...lead,
      conversationStarted: Boolean(lastMessageByLead.get(key)),
      whatsappMessageStatus: waJob?.status || wa.sentStatus || "not_sent",
      whatsappSentAt: waJob?.sentAt || wa.sentAt || null,
      whatsappReplyAt: wa.replyAt || null,
      whatsappReplyCount: wa.replyCount || 0,
      emailMessageStatus: emailJob?.status || email.status || "not_sent",
      emailSentAt: emailJob?.sentAt || email.sentAt || null,
      emailReplyAt: email.replyAt || null,
      emailReplyCount: email.replyCount || 0,
      lastReplyAt: [wa.replyAt, email.replyAt].filter(Boolean).sort((a, b) => new Date(b) - new Date(a))[0] || null,
      replyReceived: Boolean(wa.replyAt || email.replyAt),
      siteVisitCount: visit?.siteVisitCount || 0,
      latestSiteVisit: visit?.latestVisit || null,
      leadType: leadTypeFor({
        score: lead.leadScore,
        hasVisit: Boolean(visit?.siteVisitCount) || lead.status === "site_visit",
        replied: Boolean(wa.replyAt || email.replyAt),
      }),
    };
  });

  return new ApiResponse(200, {
    leads: leadsWithStatus,
    sources: (sources || []).filter(Boolean).sort(),
    summary: { total: allLeads, whatsappAvailable, emailAvailable, bothAvailable, whatsappOnly, emailOnly, siteVisits, qualified: qualifiedCounts },
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  }).send(res);
});

/**
 * GET /api/leads/import-files — the sheets contacts were uploaded from, newest first.
 */
const listImportFiles = asyncHandler(async (req, res) => {
  const ownerFilter = scopeToOwner(req);
  const ownerId = new (require("mongoose").Types.ObjectId)(String(ownerFilter.ownerId));
  const rows = await Lead.aggregate([
    { $match: { ownerId } },
    { $group: {
      _id: { $ifNull: ["$importFile", ""] },
      count: { $sum: 1 },
      whatsapp: { $sum: { $cond: [{ $gt: [{ $strLenCP: { $ifNull: ["$phone", ""] } }, 0] }, 1, 0] } },
      email: { $sum: { $cond: [{ $gt: [{ $strLenCP: { $ifNull: ["$email", ""] } }, 0] }, 1, 0] } },
      lastAt: { $max: "$createdAt" },
    } },
    { $sort: { lastAt: -1 } },
  ]);
  const files = rows.map((row) => ({
    file: row._id || "__manual__",
    label: row._id || "Manually added / older contacts",
    count: row.count, whatsapp: row.whatsapp, email: row.email, lastAt: row.lastAt,
  }));
  return new ApiResponse(200, { files }).send(res);
});

/**
 * GET /api/leads/:id
 */
const getLead = asyncHandler(async (req, res) => {
  const lead = await Lead.findOne({ _id: req.params.id, ...scopeToOwner(req) });
  if (!lead) throw ApiError.notFound("Lead not found");
  return new ApiResponse(200, { lead }).send(res);
});

/**
 * PATCH /api/leads/:id
 */
const updateLead = asyncHandler(async (req, res) => {
  const updates = { ...req.body };
  const currentLead = await Lead.findOne({ _id: req.params.id, ...scopeToOwner(req) });
  if (!currentLead) throw ApiError.notFound("Lead not found");
  if (Object.prototype.hasOwnProperty.call(updates, "phone")) {
    if (updates.phone && String(updates.phone).trim()) {
      const result = normalizePhone(updates.phone, phoneOpts(req));
      if (!result.ok) throw ApiError.badRequest(result.error || "Enter a valid mobile number");
      updates.phone = result.phone;
    } else updates.phone = null;
    if (updates.phone) {
      const dupe = await Lead.findOne({ ownerId: req.user.id, phone: { $in: phoneVariants(updates.phone) }, _id: { $ne: req.params.id } });
      if (dupe) throw ApiError.conflict("Another contact already has this number");
    }
  }
  if (Object.prototype.hasOwnProperty.call(updates, "email")) {
    updates.email = String(updates.email || "").trim().toLowerCase() || null;
    if (updates.email && !isValidEmail(updates.email)) throw ApiError.badRequest("Invalid email format");
    if (updates.email) {
      const duplicateEmail = await Lead.findOne({ ownerId: req.user.id, email: updates.email, _id: { $ne: req.params.id } });
      if (duplicateEmail) throw ApiError.conflict("Another contact already has this email");
    }
  }

  const finalPhone = Object.prototype.hasOwnProperty.call(updates, "phone") ? updates.phone : currentLead.phone;
  const finalEmail = Object.prototype.hasOwnProperty.call(updates, "email") ? updates.email : currentLead.email;
  if (!String(finalPhone || '').trim() && !String(finalEmail || '').trim()) {
    throw ApiError.badRequest("A lead needs at least a phone or email");
  }
  if (Object.prototype.hasOwnProperty.call(updates, "name") && !String(updates.name || '').trim()) {
    updates.name = (finalEmail ? String(finalEmail).split('@')[0].replace(/[._+-]+/g, ' ').trim() : `Lead ${String(finalPhone || '').replace(/\D/g, '').slice(-4)}`) || 'New lead';
    updates.name = updates.name.slice(0, 150);
  }

  const lead = await Lead.findOneAndUpdate(
    { _id: req.params.id, ...scopeToOwner(req) },
    { $set: updates },
    { new: true, runValidators: true },
  );
  if (!lead) throw ApiError.notFound("Lead not found");

  // WhatsApp contacts gain a conversation shell when a number is added later;
  // do not enqueue unsolicited messages here—leave sending to the user/campaign.
  if (lead.phone) {
    await Conversation.updateOne(
      { ownerId: lead.ownerId, leadId: lead._id },
      { $setOnInsert: { ownerId: lead.ownerId, leadId: lead._id } },
      { upsert: true },
    );
  }

  return new ApiResponse(200, { lead }, "Lead updated").send(res);
});

/**
 * DELETE /api/leads/:id
 */
const deleteLead = asyncHandler(async (req, res) => {
  const lead = await Lead.findOneAndDelete({
    _id: req.params.id,
    ...scopeToOwner(req),
  });
  if (!lead) throw ApiError.notFound("Lead not found");

  await Conversation.deleteOne({ leadId: lead._id });

  return new ApiResponse(200, null, "Lead deleted").send(res);
});

/**
 * POST /api/leads/bulk-delete
 */
const bulkDeleteLeads = asyncHandler(async (req, res) => {
  const { ids } = req.body;
  const filter = { _id: { $in: ids }, ...scopeToOwner(req) };

  const result = await Lead.deleteMany(filter);
  await Conversation.deleteMany({ leadId: { $in: ids } });

  return new ApiResponse(
    200,
    { deletedCount: result.deletedCount },
    "Leads deleted",
  ).send(res);
});

/**
 * POST /api/leads/:id/tags   body: { add?: string[], remove?: string[] }
 */
const updateTags = asyncHandler(async (req, res) => {
  const lead = await Lead.findOne({ _id: req.params.id, ...scopeToOwner(req) });
  if (!lead) throw ApiError.notFound("Lead not found");

  const { add = [], remove = [] } = req.body;
  let tags = new Set(lead.tags);
  add.forEach((t) => tags.add(t));
  remove.forEach((t) => tags.delete(t));
  lead.tags = Array.from(tags);
  await lead.save();

  return new ApiResponse(200, { lead }, "Tags updated").send(res);
});

/**
 * GET /api/leads/export
 * Exports the current filtered view as a downloadable CSV (same filters as listLeads).
 */
const exportLeads = asyncHandler(async (req, res) => {
  const { search, status, city, tag } = req.query;
  const filter = { ...scopeToOwner(req) };
  if (status) filter.status = status;
  if (city) filter.city = new RegExp(`^${city}$`, "i");
  if (tag) filter.tags = tag;
  if (search) {
    const escaped = String(search).trim().slice(0, 120).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (escaped) {
      const re = new RegExp(escaped, 'i');
      filter.$or = [
        { name: re }, { email: re }, { phone: re }, { city: re },
        { notes: re }, { requirements: re },
      ];
    }
  }

  const leads = await Lead.find(filter).sort({ createdAt: -1 }).lean();

  const fields = [
    "name",
    "phone",
    "email",
    "city",
    "location",
    "address",
    "jobTitle",
    "budgetMin",
    "budgetMax",
    "occupation",
    "age",
    "source",
    "status",
    "leadScore",
    "tags",
    "notes",
    "requirements",
    "createdAt",
  ];
  const parser = new CsvParser({ fields });
  const csv = parser.parse(
    leads.map((l) => ({ ...l, tags: (l.tags || []).join("|") })),
  );

  res.setHeader("Content-Type", "text/csv");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="leads-export-${Date.now()}.csv"`,
  );
  return res.send(csv);
});

module.exports = {
  previewImport,
  previewText,
  confirmImport,
  startConversations,
  createLead,
  listLeads,
  listImportFiles,
  getLead,
  updateLead,
  deleteLead,
  bulkDeleteLeads,
  updateTags,
  exportLeads,
};
