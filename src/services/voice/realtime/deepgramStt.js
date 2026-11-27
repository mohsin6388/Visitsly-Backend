const { EventEmitter } = require('events');
const WebSocket = require('ws');
const logger = require('../../../utils/logger');

/**
 * Live speech-to-text over Deepgram's streaming API.
 *
 * Phone audio (μ-law, 8 kHz — exactly what Plivo streams) goes in as it
 * arrives; text comes out while the customer is still talking.
 *
 * Events
 *   partial  (text)               interim words (customer still speaking)
 *   final    (text, speechFinal)  a finished piece; speechFinal = they paused
 *   utteranceEnd ()               backup "they stopped talking" signal
 *   speechStarted ()              voice detected
 *   error (err) / close ()
 *
 * .env
 *   DEEPGRAM_API_KEY=...                 (required for real-time calls)
 *   DEEPGRAM_MODEL=nova-3
 *   DEEPGRAM_LANGUAGES_JSON={"hi":"multi","en":"en-IN","ar":"ar"}   (optional)
 *   VOICE_ENDPOINTING_MS=350             (silence that ends a sentence)
 *   VOICE_UTTERANCE_END_MS=1000          (backup end-of-turn signal)
 *   DEEPGRAM_WS_URL=wss://api.deepgram.com/v1/listen   (optional: EU / self-hosted endpoint)
 */
const DEFAULT_LANG = { hi: 'multi', en: 'multi', ar: 'multi' };

function langFor(language) {
  let map = {};
  try { map = JSON.parse(process.env.DEEPGRAM_LANGUAGES_JSON || '{}') || {}; } catch { map = {}; }
  return map[language] || DEFAULT_LANG[language] || 'multi';
}

function isConfigured() {
  return Boolean(String(process.env.DEEPGRAM_API_KEY || '').trim());
}

class DeepgramStt extends EventEmitter {
  constructor({ language = 'hi', keyterms = [] } = {}) {
    super();
    this.language = language;
    this.keyterms = keyterms.map((k) => String(k || '').trim()).filter((k) => k && k.length <= 60).slice(0, 20);
    this.ws = null;
    this.pending = []; // audio received before the socket opened
    this.closed = false;
    this.reconnects = 0;
    this.keepAlive = null;
  }

  url() {
    const model = process.env.DEEPGRAM_MODEL || 'nova-3';
    const p = new URLSearchParams({
      model,
      language: langFor(this.language),
      encoding: 'mulaw',
      sample_rate: '8000',
      channels: '1',
      interim_results: 'true',
      punctuate: 'true',
      smart_format: 'true',
      vad_events: 'true',
      endpointing: String(Math.max(100, Number(process.env.VOICE_ENDPOINTING_MS) || 350)),
      utterance_end_ms: String(Math.max(1000, Number(process.env.VOICE_UTTERANCE_END_MS) || 1000)),
    });
    // Keyterm prompting (Nova-3): helps with names / project names.
    if (/^nova-3/.test(model)) for (const k of this.keyterms) p.append('keyterm', k);
    const base = process.env.DEEPGRAM_WS_URL || 'wss://api.deepgram.com/v1/listen';
    return `${base}?${p.toString()}`;
  }

  connect() {
    if (this.closed) return;
    const startedAt = Date.now();
    const ws = new WebSocket(this.url(), {
      headers: { Authorization: `Token ${String(process.env.DEEPGRAM_API_KEY).trim()}` },
      perMessageDeflate: false,
    });
    this.ws = ws;

    ws.on('open', () => {
      logger.info('[rt-stt] connected', { ms: Date.now() - startedAt, language: langFor(this.language) });
      for (const chunk of this.pending) ws.send(chunk);
      this.pending = [];
      clearInterval(this.keepAlive);
      this.keepAlive = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'KeepAlive' }));
      }, 8000);
    });

    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'Results') {
        const text = String(msg.channel?.alternatives?.[0]?.transcript || '').trim();
        if (!text) {
          if (msg.speech_final) this.emit('final', '', true);
          return;
        }
        if (msg.is_final) this.emit('final', text, Boolean(msg.speech_final));
        else this.emit('partial', text);
      } else if (msg.type === 'UtteranceEnd') {
        this.emit('utteranceEnd');
      } else if (msg.type === 'SpeechStarted') {
        this.emit('speechStarted');
      }
    });

    ws.on('unexpected-response', (req, res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        logger.error('[rt-stt] Deepgram refused the connection', { status: res.statusCode, body: body.slice(0, 300) });
        this.emit('error', new Error(`Deepgram ${res.statusCode}: ${body.slice(0, 120)}`));
      });
    });

    ws.on('error', (err) => logger.warn('[rt-stt] socket error', { error: err.message }));

    ws.on('close', (code) => {
      clearInterval(this.keepAlive);
      if (this.closed) return this.emit('close');
      // Dropped mid-call: reconnect (a couple of times) so the call keeps listening.
      if (this.reconnects < 3) {
        this.reconnects += 1;
        logger.warn('[rt-stt] connection dropped, reconnecting', { code, attempt: this.reconnects });
        setTimeout(() => this.connect(), 200 * this.reconnects);
      } else {
        this.emit('close');
      }
      return undefined;
    });
  }

  /** μ-law audio bytes from the call. */
  send(buf) {
    if (this.closed) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(buf);
    else if (this.pending.length < 500) this.pending.push(buf); // ~10 s of audio max
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.keepAlive);
    try {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'CloseStream' }));
        setTimeout(() => { try { this.ws.close(); } catch { /* already closed */ } }, 300);
      } else {
        this.ws?.terminate();
      }
    } catch { /* already closed */ }
  }
}

module.exports = { DeepgramStt, isConfigured, langFor };
