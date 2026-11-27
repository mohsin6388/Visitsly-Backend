const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const Notification = require('../models/Notification');
const Conversation = require('../models/Conversation');
const agentScope = require('../services/saas/agentScope');

/**
 * Notifications live on the company workspace (userId = owner). An agent only gets the ones
 * about leads/chats assigned to them; company notices (billing, limits, campaigns) stay with the owner.
 */
async function visibleForAgent(req, extra = {}) {
  const ids = new Set((await agentScope.assignedLeadIds(req)).map(String));
  const rows = await Notification.find({ userId: req.user.id, ...extra }).sort({ createdAt: -1 }).limit(500).lean();
  const convIds = rows.map((n) => agentScope.idsInLink(n.link).conversationId).filter(Boolean);
  const convLead = new Map();
  if (convIds.length) {
    const convs = await Conversation.find({ _id: { $in: convIds }, ownerId: req.user.id }).select('leadId').lean();
    convs.forEach((c) => convLead.set(String(c._id), String(c.leadId)));
  }
  return rows.filter((n) => {
    const { leadId, conversationId } = agentScope.idsInLink(n.link);
    return (leadId && ids.has(leadId)) || (conversationId && ids.has(convLead.get(conversationId)));
  });
}

/** GET /api/notifications — paginated list, newest first, optional ?unread=true */
const listNotifications = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20, unread } = req.query;
  if (agentScope.isAgent(req)) {
    const all = await visibleForAgent(req);
    const rows = unread === 'true' ? all.filter((n) => !n.isRead) : all;
    const start = (Number(page) - 1) * Number(limit);
    return new ApiResponse(200, {
      items: rows.slice(start, start + Number(limit)),
      unreadCount: all.filter((n) => !n.isRead).length,
      pagination: { page: Number(page), limit: Number(limit), total: rows.length },
    }, 'Notifications fetched').send(res);
  }
  const filter = { userId: req.user.id };
  if (unread === 'true') filter.isRead = false;

  const [items, total, unreadCount] = await Promise.all([
    Notification.find(filter)
      .sort({ createdAt: -1 })
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit)),
    Notification.countDocuments(filter),
    Notification.countDocuments({ userId: req.user.id, isRead: false }),
  ]);

  return new ApiResponse(200, {
    items,
    unreadCount,
    pagination: { page: Number(page), limit: Number(limit), total },
  }, 'Notifications fetched').send(res);
});

/** PATCH /api/notifications/:id/read — mark a single notification as read. */
const markAsRead = asyncHandler(async (req, res) => {
  if (agentScope.isAgent(req) && !(await visibleForAgent(req)).some((n) => String(n._id) === String(req.params.id))) throw ApiError.notFound('Notification not found');
  const notification = await Notification.findOneAndUpdate(
    { _id: req.params.id, userId: req.user.id },
    { isRead: true },
    { new: true }
  );
  if (!notification) throw ApiError.notFound('Notification not found');
  return new ApiResponse(200, notification, 'Notification marked as read').send(res);
});

/** PATCH /api/notifications/read-all — mark every unread notification as read. */
const markAllAsRead = asyncHandler(async (req, res) => {
  if (agentScope.isAgent(req)) {
    const ids = (await visibleForAgent(req, { isRead: false })).map((n) => n._id);
    await Notification.updateMany({ _id: { $in: ids }, userId: req.user.id }, { isRead: true });
    return new ApiResponse(200, null, 'All notifications marked as read').send(res);
  }
  await Notification.updateMany({ userId: req.user.id, isRead: false }, { isRead: true });
  return new ApiResponse(200, null, 'All notifications marked as read').send(res);
});

/** DELETE /api/notifications/:id */
const deleteNotification = asyncHandler(async (req, res) => {
  if (agentScope.isAgent(req)) throw ApiError.forbidden('Only the company owner can delete notifications');
  const notification = await Notification.findOneAndDelete({ _id: req.params.id, userId: req.user.id });
  if (!notification) throw ApiError.notFound('Notification not found');
  return new ApiResponse(200, null, 'Notification deleted').send(res);
});

/**
 * Internal helper (not an HTTP handler) — used by other services (lead scoring,
 * follow-up generation, whatsapp inbound handler, etc.) to create notifications
 * without duplicating the shape everywhere.
 */
const createNotification = async ({ userId, type, title, body = '', link = null }) => {
  return Notification.create({ userId, type, title, body, link });
};

module.exports = {
  listNotifications,
  markAsRead,
  markAllAsRead,
  deleteNotification,
  createNotification,
};
