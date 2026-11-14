const mongoose = require("mongoose");
const axios = require("axios");
const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");
const ApiResponse = require("../utils/ApiResponse");
const Conversation = require("../models/Conversation");
const Lead = require("../models/Lead");
const Message = require("../models/Message");
const LeadScore = require("../models/LeadScore");
const FollowUp = require("../models/FollowUp");
const Meeting = require("../models/Meeting");
const Property = require("../models/Property");
const metaWhatsappClient = require("../services/whatsapp/metaWhatsappClient");
const mediaService = require("../services/whatsapp/mediaService");
const { recordOutboundMessage } = require("../services/whatsapp/messageStore");
const { aiReplyLimitInfo } = require("../services/saas/subscription");
const tenantContext = require("../context/tenantContext");
const logger = require("../utils/logger");

/** Brokers see only their own conversations; admins may pass ?ownerId= to inspect a specific broker. */
function scopeOwnerId(req) {
  if (req.user.role === "admin" && req.query.ownerId) return req.query.ownerId;
  return req.user.id;
}

const oid = (v) => new mongoose.Types.ObjectId(String(v));
const escapeRe = (s) => String(s).trim().slice(0, 120).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Inbox filters. Lead-temperature filters read the lead's CURRENT status, so a
 * chat moves between Hot / Warm / Site visit automatically as the AI scores it.
 */
const LEAD_STATUS_FILTERS = {
  hot: { "lead.status": "hot" },
  warm: { "lead.status": "warm" },
  cold: { "lead.status": { $in: ["cold", "new", "contacted"] } },
  site_visit: { "lead.status": "site_visit" },
  closed: { $or: [{ "lead.status": "closed" }, { status: "closed" }] },
  lost: { "lead.status": "lost" },
  direct: { "lead.source": "whatsapp_inbound" },
  campaign: { "lead.source": { $ne: "whatsapp_inbound" } },
};

function withinWindow(lastInboundAt) {
  const t = lastInboundAt ? new Date(lastInboundAt).getTime() : 0;
  return t > 0 && Date.now() - t < 24 * 60 * 60 * 1000;
}

/**
 * GET /api/conversations
 * Query: filter, search, limit, before (ISO date cursor = lastMessageAt of the
 * last row already shown), leadId.
 *
 * Built for large inboxes: one indexed aggregate (ownerId + lastMessageAt),
 * no scan of the Messages collection, cursor pagination instead of skip.
 */
const listConversations = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const { filter, search, leadId, before } = req.query;
  const limit = Math.min(Number(req.query.limit) || 30, 100);

  // A thread only appears once a real message exists (imported contacts keep
  // an empty conversation shell until the first send/reply).
  const match = { ownerId: oid(ownerId), lastMessageAt: { $ne: null } };
  if (before) {
    const d = new Date(before);
    if (!Number.isNaN(d.getTime())) match.lastMessageAt = { $ne: null, $lt: d };
  }
  if (filter === "unread") match.unreadCount = { $gt: 0 };
  if (filter === "manual") match.status = "manual";
  if (filter === "needs_reply") {
    match.lastMessageDirection = "inbound";
  }
  if (leadId) match.leadId = oid(leadId);
  if (req.user.orgRole === "agent" && req.org?.routing?.agentsSeeOnlyAssigned) {
    match.assignedTo = oid(req.user.actorId);
  }

  const pipeline = [
    { $match: match },
    { $sort: { lastMessageAt: -1 } },
    {
      $lookup: {
        from: "leads",
        localField: "leadId",
        foreignField: "_id",
        as: "lead",
        pipeline: [{ $project: { name: 1, phone: 1, city: 1, status: 1, leadScore: 1, source: 1, assignedTo: 1, email: 1, optedOut: 1 } }],
      },
    },
    { $unwind: "$lead" },
  ];
  const leadMatch = LEAD_STATUS_FILTERS[filter];
  if (leadMatch) pipeline.push({ $match: leadMatch });
  if (search) {
    const re = new RegExp(escapeRe(search), "i");
    const digits = String(search).replace(/\D/g, "");
    pipeline.push({
      $match: {
        $or: [
          { "lead.name": re },
          { "lead.phone": digits.length >= 4 ? new RegExp(digits) : re },
          { lastMessagePreview: re },
        ],
      },
    });
  }
  pipeline.push(
    { $limit: limit + 1 },
    {
      $project: {
        leadId: "$lead",
        status: 1,
        unreadCount: 1,
        lastMessageAt: 1,
        lastInboundAt: 1,
        lastMessagePreview: 1,
        lastMessageDirection: 1,
        lastMessageSender: 1,
        currentLeadScore: 1,
        meetingStatus: 1,
        aiReplyCount: 1,
        optedOut: 1,
        assignedTo: 1,
        phoneNumberId: 1,
      },
    },
  );

  const rows = await Conversation.aggregate(pipeline).allowDiskUse(true);
  const hasMore = rows.length > limit;
  const conversations = rows.slice(0, limit).map((c) => ({
    ...c,
    aiLimit: aiReplyLimitInfo(req.org, c.aiReplyCount),
    windowOpen: withinWindow(c.lastInboundAt),
  }));

  // Cheap badge count (indexed) for the "Unread" chip.
  const unreadTotal = await Conversation.countDocuments({
    ownerId,
    lastMessageAt: { $ne: null },
    unreadCount: { $gt: 0 },
  });

  return new ApiResponse(200, {
    conversations,
    nextCursor: hasMore ? conversations[conversations.length - 1]?.lastMessageAt : null,
    hasMore,
    counts: { unread: unreadTotal },
    // Kept for older clients.
    pagination: { page: 1, limit, total: conversations.length, totalPages: hasMore ? 2 : 1 },
  }).send(res);
});

/** GET /api/conversations/counts — numbers for the filter menu. */
const filterCounts = asyncHandler(async (req, res) => {
  const ownerId = oid(scopeOwnerId(req));
  const base = { ownerId, lastMessageAt: { $ne: null } };
  const [unread, manual, byLead] = await Promise.all([
    Conversation.countDocuments({ ...base, unreadCount: { $gt: 0 } }),
    Conversation.countDocuments({ ...base, status: "manual" }),
    Conversation.aggregate([
      { $match: base },
      { $lookup: { from: "leads", localField: "leadId", foreignField: "_id", as: "lead", pipeline: [{ $project: { status: 1, source: 1 } }] } },
      { $unwind: "$lead" },
      {
        $group: {
          _id: null,
          all: { $sum: 1 },
          hot: { $sum: { $cond: [{ $eq: ["$lead.status", "hot"] }, 1, 0] } },
          warm: { $sum: { $cond: [{ $eq: ["$lead.status", "warm"] }, 1, 0] } },
          site_visit: { $sum: { $cond: [{ $eq: ["$lead.status", "site_visit"] }, 1, 0] } },
          closed: { $sum: { $cond: [{ $or: [{ $eq: ["$lead.status", "closed"] }, { $eq: ["$status", "closed"] }] }, 1, 0] } },
          lost: { $sum: { $cond: [{ $eq: ["$lead.status", "lost"] }, 1, 0] } },
          direct: { $sum: { $cond: [{ $eq: ["$lead.source", "whatsapp_inbound"] }, 1, 0] } },
        },
      },
    ]).allowDiskUse(true),
  ]);
  const c = byLead[0] || {};
  return new ApiResponse(200, {
    counts: {
      all: c.all || 0,
      unread,
      manual,
      hot: c.hot || 0,
      warm: c.warm || 0,
      site_visit: c.site_visit || 0,
      closed: c.closed || 0,
      lost: c.lost || 0,
      direct: c.direct || 0,
    },
  }).send(res);
});

/**
 * GET /api/conversations/:id
 * Thread + right-hand panel. Messages are paginated with `before` (the
 * timestamp of the oldest message already loaded) for "load older".
 */
const getConversation = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const limit = Math.min(Number(req.query.limit) || 40, 200);

  const conversation = await Conversation.findOne({ _id: req.params.id, ownerId })
    .populate("leadId")
    .populate("recommendedProperties", "projectName city location bhk budgetMin budgetMax images brochureUrl");
  if (!conversation) throw ApiError.notFound("Conversation not found");

  const msgFilter = { conversationId: conversation._id };
  if (req.query.before) {
    const d = new Date(req.query.before);
    if (!Number.isNaN(d.getTime())) msgFilter.timestamp = { $lt: d };
  }
  const messages = await Message.find(msgFilter).sort({ timestamp: -1 }).limit(limit + 1).lean();
  const hasMoreMessages = messages.length > limit;
  const page = messages.slice(0, limit).reverse(); // oldest -> newest for the chat UI

  // Older-messages requests only need messages.
  if (req.query.before) {
    return new ApiResponse(200, { messages: page, hasMoreMessages }).send(res);
  }

  const leadObjectId = conversation.leadId?._id || conversation.leadId;
  const [latestScore, followUp, meetings] = await Promise.all([
    LeadScore.findOne({ leadId: leadObjectId }).sort({ createdAt: -1 }).lean(),
    FollowUp.findOne({ leadId: leadObjectId, status: "pending" }).sort({ nextFollowUpDate: 1 }).lean(),
    Meeting.find({ leadId: leadObjectId, status: { $ne: "cancelled" } })
      .populate("propertyId", "projectName city")
      .sort({ preferredDate: -1, preferredTime: -1 })
      .limit(5)
      .lean(),
  ]);

  return new ApiResponse(200, {
    conversation: {
      ...conversation.toObject(),
      aiLimit: aiReplyLimitInfo(req.org, conversation.aiReplyCount),
      windowOpen: withinWindow(conversation.lastInboundAt),
    },
    messages: page,
    hasMoreMessages,
    insights: { latestScore, followUp, meetings },
  }).send(res);
});

async function loadForSend(req) {
  const ownerId = scopeOwnerId(req);
  const conversation = await Conversation.findOne({ _id: req.params.id, ownerId }).populate("leadId");
  if (!conversation) throw ApiError.notFound("Conversation not found");
  if (!conversation.leadId) throw ApiError.badRequest("Is chat ki lead delete ho chuki hai");
  if (!conversation.leadId.phone) throw ApiError.badRequest("Is lead ka WhatsApp number nahi hai");

  const settingsService = require("../services/settings/settingsService");
  const settings = await settingsService.getOrCreateSettings();
  if (settings.whatsappDisconnected) {
    throw ApiError.badRequest("WhatsApp band hai — Settings se dobara chalu karein", { code: "WHATSAPP_DISCONNECTED" });
  }
  if (!withinWindow(conversation.lastInboundAt)) {
    throw ApiError.badRequest(
      "Customer ne pichhle 24 ghante mein message nahi kiya, isliye WhatsApp ke rule ke hisaab se seedha message nahi ja sakta. Campaign / follow-up se approved template bhejein — customer reply karega to chat khul jayegi.",
      { code: "WHATSAPP_24H_WINDOW_CLOSED" },
    );
  }
  return { ownerId, conversation };
}

function sendError(err) {
  if (err instanceof ApiError) return err;
  const code = err.code || err.metaError?.code;
  if (code === "WHATSAPP_24H_WINDOW_CLOSED") {
    return ApiError.badRequest("Customer ka 24 ghante wala WhatsApp window band ho gaya hai. Template se message bhejein.", { code });
  }
  const friendly = require("../services/saas/whatsappConnect").friendlyMetaMessage(err.metaError, err.message || "Message nahi gaya");
  return ApiError.badRequest(friendly, { code: code || "WHATSAPP_SEND_FAILED" });
}

/**
 * POST /api/conversations/:id/messages
 * Broker sends a message by hand. Does NOT change conversation.status.
 */
const sendManualReply = asyncHandler(async (req, res) => {
  const { ownerId, conversation } = await loadForSend(req);
  const text = String(req.body.text || "").trim();
  let messageId;
  try {
    ({ messageId } = await tenantContext.runWithNumber(conversation.phoneNumberId, () =>
      metaWhatsappClient.sendTextMessage({ phone: conversation.leadId.phone, text }),
    ));
  } catch (err) {
    throw sendError(err);
  }
  const message = await recordOutboundMessage({
    conversationId: conversation._id,
    leadId: conversation.leadId._id,
    text,
    sender: "broker",
    whatsappMessageId: messageId || null,
    ownerId,
  });
  return new ApiResponse(201, { message }, "Message sent").send(res);
});

/**
 * POST /api/conversations/:id/media  (multipart: file, caption)
 * Broker sends a photo / video / PDF / audio from the inbox.
 */
const sendMediaReply = asyncHandler(async (req, res) => {
  if (!req.file) throw ApiError.badRequest("File chunein");
  const { ownerId, conversation } = await loadForSend(req);
  const { originalname, mimetype, size, buffer } = req.file;
  let kind;
  try {
    kind = mediaService.validateUpload({ mimeType: mimetype, size, filename: originalname });
  } catch (err) {
    throw ApiError.badRequest(err.message);
  }
  const caption = String(req.body.caption || "").trim().slice(0, 1024);

  let mediaId;
  let messageId;
  try {
    ({ mediaId, messageId } = await tenantContext.runWithNumber(conversation.phoneNumberId, async () => {
      const id = await mediaService.uploadToMeta({ buffer, mimeType: mimetype, filename: originalname });
      const sent = await mediaService.sendMedia({ phone: conversation.leadId.phone, kind, mediaId: id, caption, filename: originalname });
      return { mediaId: id, messageId: sent.messageId };
    }));
  } catch (err) {
    throw sendError(err);
  }

  // Keep a permanent copy for the inbox when storage is configured.
  let url = null;
  try {
    const { uploadBufferToCloudinary, isCloudinaryConfigured } = require("../services/cloudinaryUpload");
    if (isCloudinaryConfigured()) {
      const result = await uploadBufferToCloudinary(buffer, {
        folder: `whatsapp-media/${String(conversation._id)}`,
        resourceType: kind === "image" ? "image" : kind === "video" || kind === "audio" ? "video" : "raw",
        filename: originalname,
      });
      url = result.secure_url;
    }
  } catch (err) {
    logger.warn("[media] outbound copy failed (message was still sent)", { error: err.message });
  }

  const message = await recordOutboundMessage({
    conversationId: conversation._id,
    leadId: conversation.leadId._id,
    text: caption,
    sender: "broker",
    type: kind,
    media: { id: mediaId, url, mimeType: mimetype, filename: originalname, caption: caption || null, size },
    whatsappMessageId: messageId || null,
    ownerId,
  });
  return new ApiResponse(201, { message }, "File bhej di gayi").send(res);
});

/**
 * POST /api/conversations/:id/property-media  { propertyId, kind: 'brochure'|'photos' }
 * One-click "send brochure / photos" of a project from the inbox.
 */
const sendPropertyMedia = asyncHandler(async (req, res) => {
  const { ownerId, conversation } = await loadForSend(req);
  const property = await Property.findOne({ _id: req.body.propertyId, ownerId });
  if (!property) throw ApiError.notFound("Property nahi mili");
  const { attachSiteBrochure } = require("../services/sites/siteBrochure");
  await attachSiteBrochure(property).catch(() => null);
  const lead = conversation.leadId;
  const sent = [];
  try {
    await tenantContext.runWithNumber(conversation.phoneNumberId, async () => {
      if (req.body.kind === "brochure") {
        if (!property.brochureUrl) throw ApiError.badRequest("Is property ka brochure upload nahi hai — Properties page par brochure jodein.");
        const filename = property.brochureName || `${property.projectName || "property"}-brochure.pdf`;
        const caption = `${property.projectName || "Property"} ka brochure 📄`;
        const { messageId } = await mediaService.sendMedia({ phone: lead.phone, kind: "document", link: property.brochureUrl, caption, filename });
        sent.push(await recordOutboundMessage({ conversationId: conversation._id, leadId: lead._id, text: caption, sender: "broker", type: "document", media: { url: property.brochureUrl, filename, mimeType: "application/pdf", caption }, whatsappMessageId: messageId, ownerId }));
      } else {
        const images = (property.images || []).slice(0, 6);
        if (!images.length) throw ApiError.badRequest("Is property ki photos upload nahi hain — Properties page par photos jodein.");
        for (let i = 0; i < images.length; i += 1) {
          const caption = i === 0 ? `${property.projectName || "Property"} ki photos 🏠` : "";
          const { messageId } = await mediaService.sendMedia({ phone: lead.phone, kind: "image", link: images[i], caption });
          sent.push(await recordOutboundMessage({ conversationId: conversation._id, leadId: lead._id, text: caption, sender: "broker", type: "image", media: { url: images[i], caption: caption || null }, whatsappMessageId: messageId, ownerId }));
        }
      }
    });
  } catch (err) {
    throw sendError(err);
  }
  return new ApiResponse(201, { messages: sent }, req.body.kind === "brochure" ? "Brochure bhej diya" : `${sent.length} photo bhej di`).send(res);
});

/**
 * GET /api/conversations/:id/media/:messageId[?download=1]
 * Streams a chat file to the dashboard (photos inline, PDFs downloadable).
 * Served through the API so Meta tokens never reach the browser.
 */
const getMedia = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const conversation = await Conversation.findOne({ _id: req.params.id, ownerId }).select("_id phoneNumberId").lean();
  if (!conversation) throw ApiError.notFound("Conversation not found");
  const message = await Message.findOne({ _id: req.params.messageId, conversationId: conversation._id }).select("media type").lean();
  if (!message?.media) throw ApiError.notFound("File nahi mili");

  const filename = (message.media.filename || `${message.type}-${String(message._id).slice(-6)}`).replace(/[^\w.\- ]+/g, "_");
  const disposition = `${req.query.download ? "attachment" : "inline"}; filename="${filename}"`;
  res.setHeader("Cache-Control", "private, max-age=3600");

  try {
    if (message.media.url) {
      const upstream = await axios.get(message.media.url, { responseType: "stream", timeout: 60000 });
      res.setHeader("Content-Type", message.media.mimeType || upstream.headers["content-type"] || "application/octet-stream");
      res.setHeader("Content-Disposition", disposition);
      return upstream.data.pipe(res);
    }
    if (message.media.id) {
      const file = await tenantContext.runWithNumber(conversation.phoneNumberId, () => mediaService.streamFromMeta(message.media.id));
      res.setHeader("Content-Type", file.mimeType || message.media.mimeType || "application/octet-stream");
      if (file.size) res.setHeader("Content-Length", String(file.size));
      res.setHeader("Content-Disposition", disposition);
      return file.stream.pipe(res);
    }
  } catch (err) {
    logger.warn("[media] could not stream file", { messageId: String(message._id), error: err.message });
    throw new ApiError(410, "Ye file ab WhatsApp par available nahi hai (WhatsApp files ~30 din tak hi rakhta hai).");
  }
  throw ApiError.notFound("File nahi mili");
});

/** POST /api/conversations/:id/takeover — pause the AI for this one lead. */
const takeOverChat = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const conversation = await Conversation.findOneAndUpdate(
    { _id: req.params.id, ownerId },
    { $set: { status: "manual" } },
    { new: true },
  );
  if (!conversation) throw ApiError.notFound("Conversation not found");
  return new ApiResponse(200, { conversation }, "AI is chat ke liye ruk gaya — ab aap reply karenge").send(res);
});

/** POST /api/conversations/:id/resume-ai — hand the chat back to the AI. */
const resumeAI = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const conversation = await Conversation.findOneAndUpdate(
    { _id: req.params.id, ownerId },
    { $set: { status: "ai_active" } },
    { new: true },
  );
  if (!conversation) throw ApiError.notFound("Conversation not found");
  return new ApiResponse(200, { conversation }, "AI dobara chalu").send(res);
});

/** POST /api/conversations/:id/read — clears the unread badge. */
const markRead = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const conversation = await Conversation.findOneAndUpdate(
    { _id: req.params.id, ownerId },
    { $set: { unreadCount: 0 } },
    { new: true, projection: { unreadCount: 1 } },
  );
  if (!conversation) throw ApiError.notFound("Conversation not found");
  return new ApiResponse(200, { conversation }).send(res);
});

/** POST /api/conversations/:id/close */
const closeConversation = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const conversation = await Conversation.findOneAndUpdate(
    { _id: req.params.id, ownerId },
    { $set: { status: "closed" } },
    { new: true },
  );
  if (!conversation) throw ApiError.notFound("Conversation not found");
  return new ApiResponse(200, { conversation }, "Chat close ho gayi").send(res);
});

/** POST /api/conversations/:id/reopen */
const reopenConversation = asyncHandler(async (req, res) => {
  const ownerId = scopeOwnerId(req);
  const conversation = await Conversation.findOneAndUpdate(
    { _id: req.params.id, ownerId },
    { $set: { status: "ai_active", optedOut: false } },
    { new: true },
  );
  if (!conversation) throw ApiError.notFound("Conversation not found");
  return new ApiResponse(200, { conversation }, "Chat dobara khul gayi").send(res);
});

module.exports = {
  listConversations,
  filterCounts,
  getConversation,
  sendManualReply,
  sendMediaReply,
  sendPropertyMedia,
  getMedia,
  takeOverChat,
  resumeAI,
  markRead,
  closeConversation,
  reopenConversation,
};
