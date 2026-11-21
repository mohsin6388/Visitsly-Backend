const WebSocket = require('ws');
const CallLog = require('../../../models/CallLog');
const platformVoice = require('../../../config/voiceAgents');
const settingsService = require('../../settings/settingsService');
const agent = require('../voiceAgent');
const plivo = require('../plivoClient');
const { DeepgramStt } = require('./deepgramStt');
const { streamReply } = require('./llmStream');
const ttsStream = require('./ttsStream');
const logger = require('../../../utils/logger');

/**
 * One live AI phone call (real-time engine).
 *
 *   Plivo audio stream ──► Deepgram (live speech-to-text)
 *                              │  customer stops talking (~350 ms)
 *                              ▼
 *                         Gemini (streamed, sentence by sentence)
 *                              │  first sentence ready
 *                              ▼
 *                         ElevenLabs (streamed μ-law audio) ──► Plivo playAudio
 *
 * - The customer can interrupt: as soon as they say a few words while the
 *   agent is talking, the agent's audio is cleared and it listens.
 * - If the customer keeps talking after a short pause, the half-made reply is
 *   dropped and a new one is made from everything they said.
 * - The call result (visit confirmed / new date / follow-up …) is read from
 *   the transcript by extractOutcome() and applied when the call ends.
 */
const n = (k, d) => (Number.isFinite(Number(process.env[k])) && process.env[k] !== '' ? Number(process.env[k]) : d);
const BARGE_IN_WORDS = Math.max(1, n('VOICE_BARGE_IN_WORDS', 2));
const BARGE_IN_WORDS_OPENING = Math.max(BARGE_IN_WORDS, n('VOICE_BARGE_IN_WORDS_OPENING', 4));
const SILENCE_MS = Math.max(3000, n('VOICE_SILENCE_MS', 7000));
const MAX_TURNS = Math.max(4, n('VOICE_REALTIME_MAX_TURNS', 14));
// Lead calls are real conversations (needs, properties, visit) → more room.
const MAX_TURNS_LEAD = Math.max(MAX_TURNS, n('VOICE_REALTIME_MAX_TURNS_LEAD', 24));
const FRAME = 160; // 20 ms of μ-law 8 kHz
const DEVANAGARI = /[\u0900-\u097F]/;
const SEND_BYTES = 3200; // 400 ms per playAudio message

const sessions = new Map(); // callLogId -> RealtimeCall

const LINES = {
  hearMe: { hi: 'हेलो? क्या आप मुझे सुन पा रहे हैं?', en: 'Hello? Can you hear me?', ar: 'مرحبًا، هل تسمعني؟' },
  noVoice: {
    hi: (f) => `लगता है आवाज़ नहीं आ रही। मैं आपको WhatsApp पर message ${f ? 'कर रही' : 'कर रहा'} हूँ। धन्यवाद!`,
    en: () => "I can't hear you, so I'll message you on WhatsApp. Thank you!",
    ar: () => 'لا أستطيع سماعك، سأرسل لك رسالة على واتساب. شكرًا!',
  },
};

function words(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

/** Splits streamed text into speakable sentences. */
function takeSentence(buf, { first }) {
  const m = /[.!?।]+["'”’)]*\s+/.exec(buf);
  if (m) return [buf.slice(0, m.index + m[0].length), buf.slice(m.index + m[0].length)];
  // First words matter most: allow a comma break so the agent starts sooner.
  if (first && buf.length > 28) {
    const c = buf.indexOf(', ', 8);
    if (c > 0) return [buf.slice(0, c + 1), buf.slice(c + 2)];
  }
  if (buf.length > 170) {
    const s = buf.lastIndexOf(' ', 160);
    if (s > 40) return [buf.slice(0, s), buf.slice(s + 1)];
  }
  return null;
}

/** Hindi call where the customer chose English (or back): voice each sentence in the language it is written in. */
function voiceLang(base, text) {
  if (base !== 'hi' && base !== 'en') return base;
  return DEVANAGARI.test(text) ? 'hi' : /[A-Za-z]{3}/.test(text) ? 'en' : base;
}

function cleanSpoken(text) {
  return String(text || '')
    .replace(/\[\s*END\s*\]/gi, '')
    .replace(/[*_#`~]|\[[^\]]*\]|\([^)]*:\s*[^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

class RealtimeCall {
  constructor(ws, log) {
    this.ws = ws;
    this.id = String(log._id);
    this.ownerId = log.ownerId;
    this.ctx = log.context || {};
    this.language = this.ctx.language || 'hi';
    this.female = platformVoice.agentGender() === 'female';
    this.tts = platformVoice.elevenLabs(this.language);
    this.turns = (log.turns || []).map((t) => ({ role: t.role, text: t.text, at: t.at || new Date() }));
    if (!this.turns.length && this.ctx.opening) this.turns.push({ role: 'agent', text: this.ctx.opening, at: new Date() });
    this.callUuid = log.callUuid || null;
    this.maxTurns = this.ctx.purpose === 'enquiry' ? MAX_TURNS_LEAD : MAX_TURNS;
    this.streamId = null;

    this.userParts = []; // finished pieces of what the customer is saying now
    this.lastPartial = '';
    this.lastVoiceAt = 0;
    this.deferred = ''; // short words heard while the agent was talking
    this.reply = null; // reply being made / played
    this.replySeq = 0;
    this.speaking = false; // agent audio queued and not yet played out
    this.speakingOpening = false;
    this.checkpoint = null;
    this.ending = false;
    this.noInput = 0;
    this.silenceTimer = null;
    this.resumeTimer = null;
    this.sendRemainder = Buffer.alloc(0);
    this.extractRun = null;
    this.extractedTurns = 0;
    this.finishing = null;
    this.latencies = [];

    this.stt = new DeepgramStt({
      language: this.language,
      keyterms: [this.ctx.name, this.ctx.project, this.ctx.company, platformVoice.agentName()].filter(Boolean),
    });
    this.stt.on('partial', (t) => this.onPartial(t));
    this.stt.on('final', (t, speechFinal) => this.onFinal(t, speechFinal));
    this.stt.on('utteranceEnd', () => this.endOfUtterance('utterance-end'));
    this.stt.on('speechStarted', () => { this.lastVoiceAt = Date.now(); });
    this.stt.on('error', (err) => logger.error('[rt] speech-to-text unavailable', { call: this.id, error: err.message }));
    this.stt.connect();

    ws.on('message', (raw) => this.onPlivo(raw));
    ws.on('close', () => this.finish('socket closed'));
    ws.on('error', (err) => logger.warn('[rt] call socket error', { call: this.id, error: err.message }));
    sessions.set(this.id, this);
  }

  /* ---------------- Plivo → us ---------------- */

  onPlivo(raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    switch (msg.event) {
      case 'media':
        if (msg.media?.payload) this.stt.send(Buffer.from(msg.media.payload, 'base64'));
        break;
      case 'start':
        this.streamId = msg.start?.streamId || msg.streamId || null;
        this.callUuid = msg.start?.callId || this.callUuid;
        logger.info('[rt] stream started', { call: this.id, streamId: this.streamId });
        CallLog.updateOne({ _id: this.id }, { $set: { 'context.streamStartedAt': new Date(), 'context.engine': 'realtime', ...(this.callUuid ? { callUuid: this.callUuid } : {}) } }).catch(() => {});
        this.playOpening().catch((err) => logger.error('[rt] opening failed', { call: this.id, error: err.message }));
        break;
      case 'playedStream':
        if (msg.name && msg.name === this.checkpoint) this.onAgentFinished();
        break;
      case 'dtmf':
        if (msg.dtmf?.digit) {
          if (this.speaking && !this.ending) this.interrupt();
          this.onUserText(`(pressed ${msg.dtmf.digit} on the keypad)`);
        }
        break;
      case 'stop':
        this.finish('stream stopped');
        break;
      default:
        break;
    }
  }

  /* ---------------- us → Plivo ---------------- */

  send(obj) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  /** Queues μ-law audio, in whole 20 ms frames. */
  sendAudio(buf, { flush = false } = {}) {
    let data = this.sendRemainder.length ? Buffer.concat([this.sendRemainder, buf]) : buf;
    const whole = flush ? data.length : data.length - (data.length % FRAME);
    if (flush && whole % FRAME) data = Buffer.concat([data, Buffer.alloc(FRAME - (whole % FRAME), 0xff)]);
    const end = flush ? data.length : whole;
    for (let i = 0; i < end; i += SEND_BYTES) {
      const part = data.subarray(i, Math.min(end, i + SEND_BYTES));
      this.send({ event: 'playAudio', media: { contentType: 'audio/x-mulaw', sampleRate: 8000, payload: part.toString('base64') } });
    }
    this.sendRemainder = flush ? Buffer.alloc(0) : Buffer.from(data.subarray(end));
  }

  markEnd(name) {
    this.checkpoint = name;
    this.send({ event: 'checkpoint', streamId: this.streamId, name });
  }

  clearAudio() {
    this.sendRemainder = Buffer.alloc(0);
    this.send({ event: 'clearAudio', streamId: this.streamId });
  }

  /* ---------------- speaking ---------------- */

  async playOpening() {
    const text = this.ctx.opening || '';
    const buf = await ttsStream.clip(this.tts, text, this.language);
    if (this.finishing) return;
    this.speaking = true;
    this.speakingOpening = true;
    if (buf) {
      this.sendAudio(buf, { flush: true });
    } else {
      await ttsStream.streamSentence(this.tts, text, this.language, { onAudio: (b) => this.sendAudio(b) });
      this.sendAudio(Buffer.alloc(0), { flush: true });
    }
    this.markEnd('opening');
  }

  /** A fixed line ("can you hear me?", goodbye) from the clip cache. */
  async sayFixed(text, { end = false } = {}) {
    this.cancelReply();
    this.turns.push({ role: 'agent', text, at: new Date() });
    if (end) this.ending = true;
    const buf = await ttsStream.clip(this.tts, text, this.language);
    if (this.finishing) return;
    this.speaking = true;
    if (buf) this.sendAudio(buf, { flush: true });
    else {
      await ttsStream.streamSentence(this.tts, text, this.language, { onAudio: (b) => this.sendAudio(b) });
      this.sendAudio(Buffer.alloc(0), { flush: true });
    }
    this.markEnd(`fixed-${++this.replySeq}`);
    this.persist();
  }

  /** The agent's audio finished playing on the phone. */
  onAgentFinished() {
    this.speaking = false;
    this.speakingOpening = false;
    this.checkpoint = null;
    if (this.ending) {
      setTimeout(() => this.hangup(), 400);
      return;
    }
    if (this.deferred) {
      const text = this.deferred;
      this.deferred = '';
      this.onUserText(text);
      return;
    }
    this.armSilence();
  }

  /* ---------------- listening ---------------- */

  onPartial(text) {
    this.lastVoiceAt = Date.now();
    this.lastPartial = text;
    clearTimeout(this.silenceTimer);
    const heard = words([...this.userParts, text].join(' '));
    if (this.speaking && !this.ending) {
      // Customer is talking over the agent → stop and listen.
      if (heard >= (this.speakingOpening ? BARGE_IN_WORDS_OPENING : BARGE_IN_WORDS)) this.interrupt();
    } else if (this.reply && !this.reply.audioStarted && heard >= 2) {
      // Still thinking but the customer kept talking → drop that reply, wait for the rest.
      this.dropPendingReply();
    }
  }

  onFinal(text, speechFinal) {
    if (text) {
      this.userParts.push(text);
      this.lastVoiceAt = Date.now();
      this.lastPartial = '';
      if (this.reply && !this.reply.audioStarted && !this.speaking && words(text) >= 2) this.dropPendingReply();
    }
    if (speechFinal) this.endOfUtterance('speech-final');
  }

  endOfUtterance(reason) {
    const text = this.userParts.join(' ').replace(/\s+/g, ' ').trim();
    this.userParts = [];
    this.lastPartial = '';
    if (!text) return;
    if (this.ending) return;
    if (this.speaking) {
      // A short "haan" / "ji" while the agent talks: answer it once the agent finishes.
      this.deferred = `${this.deferred} ${text}`.trim();
      return;
    }
    logger.info('[rt] customer said', { call: this.id, reason, text: text.slice(0, 200) });
    this.onUserText(text);
  }

  onUserText(text) {
    if (this.ending || this.finishing) return;
    clearTimeout(this.silenceTimer);
    clearTimeout(this.resumeTimer);
    this.noInput = 0;
    const last = this.turns[this.turns.length - 1];
    if (this.reply && !this.reply.audioStarted) this.cancelReply();
    if (last && last.role === 'customer') last.text = `${last.text} ${text}`.trim();
    else this.turns.push({ role: 'customer', text, at: new Date() });
    this.respond();
  }

  interrupt() {
    logger.info('[rt] customer interrupted the agent', { call: this.id });
    this.clearAudio();
    this.speaking = false;
    this.speakingOpening = false;
    this.checkpoint = null;
    if (this.reply) {
      // Keep what the agent was saying, marked as cut off.
      const r = this.reply;
      this.cancelReply();
      if (r.spoken && r.audioStarted) {
        this.turns.push({ role: 'agent', text: `${cleanSpoken(r.spoken)}…`, at: new Date() });
      }
    } else {
      const last = this.turns[this.turns.length - 1];
      if (last && last.role === 'agent' && !last.text.endsWith('…')) last.text = `${last.text}…`;
    }
  }

  dropPendingReply() {
    this.cancelReply();
    // If no new end-of-speech arrives, answer what we have anyway.
    clearTimeout(this.resumeTimer);
    this.resumeTimer = setTimeout(() => {
      if (this.reply || this.speaking || this.ending || this.userParts.length) return;
      const last = this.turns[this.turns.length - 1];
      if (last && last.role === 'customer') this.respond();
    }, 1800);
  }

  cancelReply() {
    if (!this.reply) return;
    this.reply.ctrl.abort();
    this.reply = null;
  }

  armSilence() {
    clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => this.onSilence(), SILENCE_MS);
  }

  onSilence() {
    if (this.finishing || this.ending || this.speaking || this.reply) return;
    if (Date.now() - this.lastVoiceAt < 1500 || this.userParts.length) return this.armSilence();
    this.noInput += 1;
    const L = ['hi', 'en', 'ar'].includes(this.language) ? this.language : 'en';
    if (this.noInput >= 2) return this.sayFixed(LINES.noVoice[L](this.female), { end: true });
    return this.sayFixed(LINES.hearMe[L]);
  }

  /* ---------------- thinking + speaking a reply ---------------- */

  async respond() {
    if (this.finishing) return;
    const reply = { id: ++this.replySeq, ctrl: new AbortController(), audioStarted: false, spoken: '', startedAt: Date.now() };
    this.reply = reply;
    const { signal } = reply.ctrl;
    const agentTurns = this.turns.filter((t) => t.role === 'agent').length;
    const history = this.turns.map((t) => ({ role: t.role === 'agent' ? 'model' : 'user', text: t.text }));
    if (agentTurns >= this.maxTurns) history.push({ role: 'user', text: '[system: this is your last reply — wrap up politely now and end with [END]]' });

    // Ordered sentence → audio pipeline: sentences are voiced in parallel but played in order.
    const items = [];
    let wake = null;
    let closed = false;
    const notify = () => { const w = wake; wake = null; w?.(); };
    const speakSentence = (raw) => {
      const text = cleanSpoken(raw);
      if (!text || signal.aborted) return;
      reply.spoken = `${reply.spoken} ${text}`.trim();
      const item = { chunks: [], done: false };
      items.push(item);
      ttsStream.streamSentence(this.tts, text, voiceLang(this.language, text), {
        signal,
        onAudio: (b) => { item.chunks.push(b); notify(); },
      }).finally(() => { item.done = true; notify(); });
    };

    const pump = (async () => {
      for (let i = 0; ; i += 1) {
        while (i >= items.length) {
          if (closed || signal.aborted) return;
          await new Promise((r) => { wake = r; });
        }
        const item = items[i];
        for (;;) {
          if (signal.aborted) return;
          while (item.chunks.length) {
            const b = item.chunks.shift();
            if (!reply.audioStarted) {
              reply.audioStarted = true;
              this.speaking = true;
              clearTimeout(this.silenceTimer);
              const ms = Date.now() - reply.startedAt;
              this.latencies.push(ms);
              logger.info('[rt] agent started speaking', { call: this.id, ms });
            }
            this.sendAudio(b);
          }
          if (item.done && !item.chunks.length) break;
          await new Promise((r) => { wake = r; });
        }
      }
    })();

    let buffer = '';
    let full = '';
    let end = false;
    try {
      const apiKey = await settingsService.getGeminiKey(this.ctx.orgId).catch(() => process.env.GEMINI_API_KEY || null);
      await streamReply({
        apiKey,
        system: agent.realtimePrompt(this.ctx, { maxTurns: this.maxTurns }),
        history,
        models: agent.VOICE_MODELS,
        signal,
        onText: (t) => {
          full += t;
          buffer += t;
          for (let s = takeSentence(buffer, { first: !items.length }); s; s = takeSentence(buffer, { first: !items.length })) {
            [, buffer] = s;
            speakSentence(s[0]);
          }
        },
      });
      if (buffer.trim()) speakSentence(buffer);
    } catch (err) {
      if (signal.aborted) return;
      logger.warn('[rt] AI reply failed, using a safe line', { call: this.id, error: err.message });
      const lastCustomer = [...this.turns].reverse().find((t) => t.role === 'customer')?.text || '';
      const fb = agent.ruleBased(this.ctx, lastCustomer);
      full = `${fb.say}${fb.end_call ? ` ${agent.END_TAG}` : ''}`;
      speakSentence(fb.say);
    }
    closed = true;
    notify();
    await pump;
    if (signal.aborted || this.reply !== reply) return;

    end = /\[\s*END\s*\]/i.test(full) || agentTurns >= this.maxTurns;
    const said = cleanSpoken(full);
    this.reply = null;
    if (!reply.audioStarted) {
      // Nothing could be voiced (TTS down): keep listening rather than hang in silence.
      logger.warn('[rt] reply produced no audio', { call: this.id });
      if (end) this.hangup();
      else this.armSilence();
      return;
    }
    this.sendAudio(Buffer.alloc(0), { flush: true });
    this.turns.push({ role: 'agent', text: said, at: new Date() });
    if (end) this.ending = true;
    this.markEnd(`reply-${reply.id}`);
    this.persist();
    // Reading the result is an extra LLM call: do it when the call is wrapping up (and again at hang-up), not on every turn.
    if (end) this.extractSoon();
  }

  /* ---------------- saving ---------------- */

  persist() {
    return CallLog.updateOne(
      { _id: this.id },
      { $set: { turns: this.turns.map((t) => ({ role: t.role, text: String(t.text || '').slice(0, 1000), at: t.at })) } },
    ).catch((err) => logger.warn('[rt] could not save transcript', { call: this.id, error: err.message }));
  }

  /** Reads the call result from the transcript (in the background, latest wins). */
  extractSoon() {
    if (this.extractRun) {
      this.extractAgain = true;
      return this.extractRun;
    }
    const customerTurns = this.turns.filter((t) => t.role === 'customer').length;
    if (!customerTurns || customerTurns === this.extractedTurns) return Promise.resolve();
    this.extractedTurns = customerTurns;
    const turns = this.turns.slice();
    this.extractRun = agent.extractOutcome(this.ctx, turns)
      .then(async (out) => {
        if (!out) return;
        const extracted = {
          visit: out.visit,
          new_date: out.new_date,
          new_time: out.new_time,
          follow_up_date: out.follow_up_date,
          interested: out.interested,
          callback_later: out.callback_later,
          lead: out.lead || null,
          rating: out.rating || null,
          rating_reason: out.rating_reason || null,
          model: out.model,
        };
        const $set = { extracted };
        if (out.summary) $set.summary = out.summary;
        if (out.interested !== null && out.interested !== undefined) $set.interested = out.interested;
        await CallLog.updateOne({ _id: this.id }, { $set });
      })
      .catch((err) => logger.warn('[rt] could not read the call result', { call: this.id, error: err.message }))
      .finally(() => {
        this.extractRun = null;
        if (this.extractAgain) {
          this.extractAgain = false;
          this.extractSoon();
        }
      });
    return this.extractRun;
  }

  async hangup() {
    if (this.hungUp) return;
    this.hungUp = true;
    if (this.callUuid) {
      await plivo.hangupCall(this.callUuid).catch((err) => logger.warn('[rt] hang-up failed', { call: this.id, error: plivo.errorText(err) }));
    }
    try { this.ws.close(); } catch { /* closed */ }
  }

  /** Call is over: stop everything and save the transcript + result (idempotent). */
  finish(reason) {
    if (this.finishing) return this.finishing;
    this.finishing = (async () => {
      logger.info('[rt] call stream ended', {
        call: this.id,
        reason,
        turns: this.turns.length,
        avgReplyMs: this.latencies.length ? Math.round(this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length) : null,
      });
      clearTimeout(this.silenceTimer);
      clearTimeout(this.resumeTimer);
      this.cancelReply();
      this.stt.close();
      // Words said right before the hang-up still count.
      const tail = [...this.userParts, this.lastPartial].join(' ').trim();
      if (tail) {
        const last = this.turns[this.turns.length - 1];
        if (last && last.role === 'customer') last.text = `${last.text} ${tail}`;
        else this.turns.push({ role: 'customer', text: tail, at: new Date() });
      }
      if (this.deferred) this.turns.push({ role: 'customer', text: this.deferred, at: new Date() });
      try { this.ws.close(); } catch { /* closed */ }
      await this.persist();
      await (this.extractRun || Promise.resolve());
      await this.extractSoon();
      setTimeout(() => sessions.delete(this.id), 60000);
    })();
    return this.finishing;
  }
}

/** Waits (bounded) for a live call's transcript + result to be saved. */
async function finishCall(callId, timeoutMs = 9000) {
  const s = sessions.get(String(callId));
  if (!s) return false;
  await Promise.race([s.finish('call hung up'), new Promise((r) => { setTimeout(r, timeoutMs); })]);
  return true;
}

/**
 * Before dialling: makes the opening line (and the fixed lines) in phone
 * audio so the customer hears the agent the instant they pick up.
 */
async function prepare(ctx) {
  const tts = platformVoice.elevenLabs(ctx.language);
  if (!tts) return false;
  const L = ['hi', 'en', 'ar'].includes(ctx.language) ? ctx.language : 'en';
  const female = platformVoice.agentGender() === 'female';
  ttsStream.clip(tts, LINES.hearMe[L], ctx.language).catch(() => {});
  ttsStream.clip(tts, LINES.noVoice[L](female), ctx.language).catch(() => {});
  return Boolean(await ttsStream.clip(tts, ctx.opening, ctx.language, { timeoutMs: 9000 }));
}

module.exports = { RealtimeCall, finishCall, prepare, sessions, takeSentence, cleanSpoken };
