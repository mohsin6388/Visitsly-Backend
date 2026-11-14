const axios = require('axios');
const FormData = require('form-data');
const env = require('../../config/env');
const Message = require('../../models/Message');
const logger = require('../../utils/logger');
const { uploadBufferToCloudinary, isCloudinaryConfigured } = require('../cloudinaryUpload');

/**
 * WhatsApp media in both directions.
 *
 * Inbound: Meta only gives a media id. We keep the id on the Message and (when
 * Cloudinary is configured) copy the file to permanent storage in the
 * background so photos/PDFs stay viewable after Meta's 30-day expiry.
 * The dashboard reads media through GET /api/conversations/:id/media/:messageId
 * which streams from the permanent copy or, failing that, from Meta.
 *
 * Outbound: the broker's file is uploaded to Meta (POST /{phone-number-id}/media)
 * and sent by media id — no public URL needed.
 */
const http = axios.create({ timeout: 60_000, maxContentLength: 110 * 1024 * 1024, maxBodyLength: 110 * 1024 * 1024 });

// Meta Cloud API limits (per media type).
const LIMITS = {
  image: { max: 5 * 1024 * 1024, types: ['image/jpeg', 'image/png', 'image/webp'] },
  video: { max: 16 * 1024 * 1024, types: ['video/mp4', 'video/3gpp'] },
  audio: { max: 16 * 1024 * 1024, types: ['audio/aac', 'audio/amr', 'audio/mpeg', 'audio/mp4', 'audio/ogg'] },
  document: { max: 100 * 1024 * 1024, types: null }, // any document type
};

function graph(path) {
  return `https://graph.facebook.com/${env.metaWhatsapp.apiVersion}/${path}`;
}

function authHeaders() {
  return { Authorization: `Bearer ${env.metaWhatsapp.accessToken}` };
}

/** Picks the WhatsApp message type for an uploaded file. */
function kindForMime(mime = '', filename = '') {
  const m = String(mime).toLowerCase();
  if (m === 'image/webp' && /sticker/i.test(filename)) return 'sticker';
  if (LIMITS.image.types.includes(m)) return 'image';
  if (LIMITS.video.types.includes(m)) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return 'document';
}

function validateUpload({ mimeType, size, filename }) {
  const kind = kindForMime(mimeType, filename);
  const limit = LIMITS[kind] || LIMITS.document;
  if (size > limit.max) {
    const mb = Math.round(limit.max / (1024 * 1024));
    const err = new Error(`File bahut badi hai. WhatsApp par ${kind === 'image' ? 'photo' : kind} ${mb} MB tak hi ja sakta hai.`);
    err.statusCode = 400;
    throw err;
  }
  return kind;
}

async function getMediaInfo(mediaId) {
  const { data } = await http.get(graph(mediaId), { headers: authHeaders() });
  return data; // { url, mime_type, sha256, file_size, id }
}

/** Streams a Meta media file (used by the dashboard proxy when no permanent copy exists). */
async function streamFromMeta(mediaId) {
  const info = await getMediaInfo(mediaId);
  const response = await http.get(info.url, { headers: authHeaders(), responseType: 'stream' });
  return { stream: response.data, mimeType: info.mime_type, size: info.file_size };
}

async function downloadFromMeta(mediaId) {
  const info = await getMediaInfo(mediaId);
  const response = await http.get(info.url, { headers: authHeaders(), responseType: 'arraybuffer' });
  return { buffer: Buffer.from(response.data), mimeType: info.mime_type, size: info.file_size, sha256: info.sha256 };
}

/**
 * Copies an inbound media file to permanent storage (best effort, background).
 * Must run inside the company's tenant context (uses its WhatsApp token).
 */
async function persistInboundMedia(messageId) {
  if (!isCloudinaryConfigured()) return null;
  const message = await Message.findById(messageId).select('media type conversationId').lean();
  if (!message?.media?.id || message.media.url) return null;
  try {
    const file = await downloadFromMeta(message.media.id);
    const resourceType = message.type === 'image' || message.type === 'sticker' ? 'image' : message.type === 'video' || message.type === 'audio' ? 'video' : 'raw';
    const result = await uploadBufferToCloudinary(file.buffer, {
      folder: `whatsapp-media/${String(message.conversationId)}`,
      resourceType,
      filename: message.media.filename || undefined,
    });
    await Message.updateOne(
      { _id: messageId },
      { $set: { 'media.url': result.secure_url, 'media.size': file.size || null, 'media.mimeType': message.media.mimeType || file.mimeType } },
    );
    return result.secure_url;
  } catch (err) {
    logger.warn('[media] Could not copy inbound media to storage', { messageId: String(messageId), error: err.message });
    return null;
  }
}

/** Uploads a file to Meta and returns its media id. */
async function uploadToMeta({ buffer, mimeType, filename }) {
  if (!env.metaWhatsapp.accessToken || !env.metaWhatsapp.phoneNumberId) {
    const err = new Error('WhatsApp number connect nahi hai — pehle WhatsApp connect karein.');
    err.code = 'META_NOT_CONFIGURED';
    throw err;
  }
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimeType);
  form.append('file', buffer, { filename: filename || 'file', contentType: mimeType });
  try {
    const { data } = await http.post(graph(`${env.metaWhatsapp.phoneNumberId}/media`), form, {
      headers: { ...authHeaders(), ...form.getHeaders() },
    });
    return data.id;
  } catch (err) {
    const metaError = err.response?.data?.error;
    const e = new Error(metaError?.error_user_msg || metaError?.message || 'File WhatsApp par upload nahi hui');
    e.code = metaError?.code || 'META_MEDIA_UPLOAD_FAILED';
    e.metaError = metaError || null;
    throw e;
  }
}

/** Sends an uploaded media id (or a public link) to a buyer. */
async function sendMedia({ phone, kind, mediaId, link, caption, filename }) {
  const client = require('./metaWhatsappClient');
  const to = client.toWhatsAppNumber(phone);
  const body = {};
  if (mediaId) body.id = mediaId;
  else body.link = link;
  if (caption && ['image', 'video', 'document'].includes(kind)) body.caption = String(caption).slice(0, 1024);
  if (filename && kind === 'document') body.filename = String(filename).slice(0, 240);
  try {
    const { data } = await http.post(
      graph(`${env.metaWhatsapp.phoneNumberId}/messages`),
      { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: kind, [kind]: body },
      { headers: { ...authHeaders(), 'Content-Type': 'application/json' } },
    );
    return { messageId: data?.messages?.[0]?.id || null };
  } catch (err) {
    const metaError = err.response?.data?.error;
    if (metaError?.code === 131047) {
      const e = new Error('WHATSAPP_24H_WINDOW_CLOSED: Customer ne 24 ghante se reply nahi kiya, isliye file nahi ja sakti. Pehle template bhejein.');
      e.code = 'WHATSAPP_24H_WINDOW_CLOSED';
      throw e;
    }
    const e = new Error(metaError?.error_user_msg || metaError?.message || 'File nahi bheji ja saki');
    e.code = metaError?.code || 'META_MEDIA_SEND_FAILED';
    e.metaError = metaError || null;
    throw e;
  }
}

module.exports = {
  LIMITS,
  kindForMime,
  validateUpload,
  getMediaInfo,
  streamFromMeta,
  downloadFromMeta,
  persistInboundMedia,
  uploadToMeta,
  sendMedia,
};
