const mongoose = require('mongoose');
const { Schema } = mongoose;

/**
 * Short ElevenLabs audio clips played on AI calls. Stored in MongoDB so any
 * server instance can serve them to Plivo; auto-deleted after 3 days.
 * `key` = hash(voice + model + text) → the same sentence is generated once.
 */
const voiceAudioSchema = new Schema({
  key: { type: String, required: true, unique: true },
  contentType: { type: String, default: 'audio/mpeg' },
  data: { type: Buffer, required: true },
  text: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now, expires: 3 * 24 * 3600 },
});

module.exports = mongoose.model('VoiceAudio', voiceAudioSchema);
