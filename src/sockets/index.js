const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const logger = require('../utils/logger');

let io = null;

/**
 * Sets up Socket.IO on the same HTTP server as Express. Clients authenticate
 * by passing their access token: `io(URL, { auth: { token } })`. Every
 * socket is placed in a room scoped to that user (`user:<id>`), so emitting
 * to `user:<brokerId>` reaches only that broker's connected clients —
 * mirroring the "never mix sessions" requirement from the WhatsApp module.
 */
function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: (origin, cb) => cb(null, require('../services/saas/corsOrigins').isAllowed(origin)), credentials: true },
    pingInterval: 25000,
    pingTimeout: 20000,
  });

  // Several API instances behind a load balancer: share socket rooms through
  // Redis so a WhatsApp reply received by instance A reaches a dashboard
  // connected to instance B. Optional — set REDIS_URL to enable.
  if (process.env.REDIS_URL) {
    try {
      const { createAdapter } = require('@socket.io/redis-adapter');
      const { createClient } = require('redis');
      const pub = createClient({ url: process.env.REDIS_URL });
      const sub = pub.duplicate();
      Promise.all([pub.connect(), sub.connect()])
        .then(() => {
          io.adapter(createAdapter(pub, sub));
          logger.info('[socket] Redis adapter enabled (multi-instance realtime)');
        })
        .catch((err) => logger.error('[socket] Redis adapter failed — realtime works per instance only', { error: err.message }));
    } catch (err) {
      logger.warn('[socket] REDIS_URL set but @socket.io/redis-adapter / redis not installed', { error: err.message });
    }
  }

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('Missing auth token'));
      const payload = jwt.verify(token, env.jwt.accessSecret);
      socket.userId = payload.sub;
      socket.role = payload.role;
      // SaaS: realtime events are emitted to the company workspace room
      // (`user:<ownerUserId>`), so every teammate joins their company's room.
      socket.roomId = payload.sub;
      socket.agentRoom = null;
      if (env.saas.enabled) {
        const User = require('../models/User');
        const orgService = require('../services/saas/orgService');
        const user = await User.findById(payload.sub).select('orgId isActive isSuperAdmin email orgRole').lean();
        if (!user || !user.isActive) return next(new Error('Account not found'));
        const superAdmin = user.isSuperAdmin || env.saas.superAdminEmails.includes(String(user.email || '').toLowerCase());
        // Support sessions (from the admin panel) carry the company id in the token.
        const orgId = (superAdmin && payload.typ === 'support' && payload.org) || user.orgId;
        if (orgId) {
          const org = await orgService.getSnapshot(orgId);
          if (org) socket.roomId = org.ownerUserId;
          // An agent is NOT placed in the company room (that carries every chat). They get a private
          // room that only receives events for leads assigned to them (see emitToUser below).
          const isOwnerSession = (superAdmin && payload.typ === 'support') || String(user.orgRole || 'owner') === 'owner';
          if (org && !isOwnerSession) socket.agentRoom = `agent:${org.ownerUserId}:${payload.sub}`;
        }
      }
      next();
    } catch (err) {
      next(new Error('Invalid or expired auth token'));
    }
  });

  io.on('connection', (socket) => {
    socket.join(socket.agentRoom || `user:${socket.roomId}`);
    logger.info(`[socket] Client connected: user:${socket.userId}`);

    socket.on('disconnect', () => {
      logger.info(`[socket] Client disconnected: user:${socket.userId}`);
    });
  });

  return io;
}

/** Used by services (e.g. WhatsApp session manager) to push events to a specific user. */
function emitToUser(userId, event, payload) {
  if (!io) return;
  io.to(`user:${userId}`).emit(event, payload);
  // Also hand the event to the assigned agent (if the event is about one of their leads).
  fanOutToAgent(userId, event, payload).catch(() => {});
}

const OID = /^[a-f\d]{24}$/i;
const pickId = (...vals) => vals.map((v) => (v && v._id ? v._id : v)).map(String).find((v) => OID.test(v)) || null;

/**
 * Agents see only leads assigned to them, so company-wide events (campaign progress, billing notices,
 * other agents' chats) never reach them. Events that name a lead (or a conversation) are sent to the
 * assigned agent's private room, with phone numbers masked unless they have "show full phone".
 */
async function fanOutToAgent(ownerId, event, payload) {
  if (!payload || typeof payload !== 'object') return;
  let leadId = pickId(payload.leadId, payload.lead, payload.message?.leadId, payload.meeting?.leadId);
  if (!leadId) {
    const conversationId = pickId(payload.conversationId);
    if (!conversationId) return;
    const Conversation = require('../models/Conversation');
    const conv = await Conversation.findOne({ _id: conversationId, ownerId }).select('leadId').lean();
    leadId = conv?.leadId ? String(conv.leadId) : null;
  }
  if (!leadId) return;
  const Lead = require('../models/Lead');
  const lead = await Lead.findOne({ _id: leadId, ownerId }).select('assignedTo').lean();
  if (!lead?.assignedTo) return;
  const User = require('../models/User');
  const agent = await User.findOne({ _id: lead.assignedTo, isActive: true }).select('orgRole permissions').lean();
  if (!agent || agent.orgRole === 'owner') return;
  const agentScope = require('../services/saas/agentScope');
  const { permissionsFor } = require('../services/saas/permissions');
  const full = permissionsFor({ orgRole: 'agent', permissions: agent.permissions }).showFullPhone === true;
  io.to(`agent:${ownerId}:${lead.assignedTo}`).emit(event, full ? payload : agentScope.maskPayload(payload));
}

function getIO() {
  if (!io) throw new Error('Socket.IO not initialized — call initSocket(server) first');
  return io;
}

module.exports = { initSocket, emitToUser, getIO, _setIO: (x) => { io = x; } /* tests only */ };
