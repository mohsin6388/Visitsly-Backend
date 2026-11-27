const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const CallLog = require('../../../models/CallLog');
const platformVoice = require('../../../config/voiceAgents');
const { isConfigured: sttConfigured } = require('./deepgramStt');
const logger = require('../../../utils/logger');

/**
 * WebSocket endpoint Plivo streams call audio to:
 *   wss://<PUBLIC_API_URL host>/api/voice/stream/<callLogId>/<token>
 * token = HMAC(callLogId) — the raw webhook secret never appears in a URL.
 * Shares the HTTP server with Express and Socket.IO (Socket.IO keeps /socket.io).
 */
const PATH = /^\/api\/voice\/stream\/([a-f\d]{24})\/([a-f\d]{32})\/?(?:\?.*)?$/i;

function signingKey() {
  return platformVoice.webhookSecret() || String(process.env.PLIVO_AUTH_TOKEN || '') || 'visitsly-voice';
}

function tokenFor(callId) {
  return crypto.createHmac('sha256', signingKey()).update(String(callId)).digest('hex').slice(0, 32);
}

function validToken(callId, token) {
  const a = Buffer.from(tokenFor(callId));
  const b = Buffer.from(String(token || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Public wss:// URL for a call. */
function streamUrl(callId) {
  const base = platformVoice.publicBase();
  if (!base) return null;
  return `${base.replace(/^http/i, 'ws')}/api/voice/stream/${callId}/${tokenFor(callId)}`;
}

/**
 * Real-time calls need Deepgram (listening) + ElevenLabs (voice).
 * VOICE_ENGINE=classic forces the old turn-by-turn engine.
 */
function enabled(language = 'hi') {
  if (String(process.env.VOICE_ENGINE || '').toLowerCase() === 'classic') return false;
  return sttConfigured() && Boolean(platformVoice.elevenLabs(language));
}

function attach(server) {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const m = PATH.exec(req.url || '');
    if (!m) return; // not ours (Socket.IO handles its own path)
    if (!validToken(m[1], m[2])) {
      logger.warn('[rt] stream with bad token rejected');
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    // Load the call first so the session listens before Plivo's first message.
    CallLog.findById(m[1])
      .then((log) => {
        if (!log || log.finalizedAt) {
          socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          try {
            const { RealtimeCall } = require('./session');
            new RealtimeCall(ws, log); // eslint-disable-line no-new
          } catch (err) {
            logger.error('[rt] could not start call session', { call: m[1], error: err.message });
            try { ws.close(1011, 'error'); } catch { /* closed */ }
          }
        });
      })
      .catch((err) => {
        logger.error('[rt] stream lookup failed', { call: m[1], error: err.message });
        socket.destroy();
      });
  });
  logger.info(`[voice] Real-time call engine ${enabled() ? 'ON (Deepgram + Gemini streaming + ElevenLabs streaming)' : 'OFF — set DEEPGRAM_API_KEY (and ElevenLabs) to enable; using the classic engine'}`);
}

module.exports = { attach, streamUrl, enabled, tokenFor };
