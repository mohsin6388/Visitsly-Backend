const logger = require('../../../utils/logger');

/**
 * Streams a Gemini reply token-by-token (server-sent events), so the first
 * sentence can be spoken while the rest is still being written.
 *
 * Tries the voice models in order; a model that does not start answering
 * within VOICE_LLM_FIRST_TOKEN_MS is abandoned for the next one.
 */
const API = 'https://generativelanguage.googleapis.com/v1beta/models';
const FIRST_TOKEN_MS = Number(process.env.VOICE_LLM_FIRST_TOKEN_MS || 1800);
const TOTAL_MS = Number(process.env.VOICE_LLM_TOTAL_MS || 9000);
const cooldown = new Map(); // model -> until (rate limited / missing)

function generationConfig(model) {
  const cfg = { temperature: 0.6, maxOutputTokens: 220 };
  // No "thinking" on a live call: it only adds silence.
  if (/^gemini-2\.5-flash/.test(model)) cfg.thinkingConfig = { thinkingBudget: 0 };
  else if (/^gemini-3/.test(model)) cfg.thinkingConfig = { thinkingLevel: 'minimal' };
  return cfg;
}

function toContents(history) {
  const contents = [];
  for (const h of history) {
    const role = h.role === 'model' ? 'model' : 'user';
    const text = String(h.text || '').trim();
    if (!text) continue;
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts[0].text += `\n${text}`;
    else contents.push({ role, parts: [{ text }] });
  }
  if (!contents.length || contents[0].role !== 'user') contents.unshift({ role: 'user', parts: [{ text: '[call connected]' }] });
  if (contents[contents.length - 1].role !== 'user') contents.push({ role: 'user', parts: [{ text: '[customer is silent]' }] });
  return contents;
}

async function streamOne({ model, apiKey, system, contents, signal, onText }) {
  const ctrl = new AbortController();
  const abort = () => ctrl.abort();
  signal?.addEventListener('abort', abort, { once: true });
  let firstTimer = setTimeout(() => ctrl.abort(new Error('first-token timeout')), FIRST_TOKEN_MS);
  const totalTimer = setTimeout(() => ctrl.abort(new Error('total timeout')), TOTAL_MS);
  const startedAt = Date.now();
  let full = '';
  try {
    const res = await fetch(`${API}/${model}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents,
        generationConfig: generationConfig(model),
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (res.status === 429 || res.status === 404) cooldown.set(model, Date.now() + (res.status === 404 ? 3600e3 : 60e3));
      throw new Error(`HTTP ${res.status} ${body.slice(0, 160)}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        let msg;
        try { msg = JSON.parse(line.slice(5)); } catch { continue; }
        const parts = msg.candidates?.[0]?.content?.parts || [];
        const text = parts.filter((p) => !p.thought).map((p) => p.text || '').join('');
        if (!text) continue;
        if (firstTimer) {
          clearTimeout(firstTimer);
          firstTimer = null;
          logger.info('[rt-llm] first words', { model, ms: Date.now() - startedAt });
        }
        full += text;
        onText(text);
      }
    }
    return full;
  } finally {
    clearTimeout(firstTimer);
    clearTimeout(totalTimer);
    signal?.removeEventListener('abort', abort);
  }
}

/**
 * history: [{ role: 'user' | 'model', text }]
 * onText(chunk) is called as words arrive. Resolves with { text, model }.
 * Throws only when every model failed before saying anything.
 */
async function streamReply({ apiKey, system, history, models, signal, onText }) {
  if (!apiKey) throw new Error('No Gemini API key');
  const contents = toContents(history);
  const errors = [];
  const list = models.filter((m) => (cooldown.get(m) || 0) < Date.now());
  for (const model of list.length ? list : models) {
    if (signal?.aborted) throw new Error('aborted');
    let spoke = false;
    try {
      const text = await streamOne({ model, apiKey, system, contents, signal, onText: (t) => { spoke = true; onText(t); } });
      return { text, model };
    } catch (err) {
      if (signal?.aborted) throw new Error('aborted');
      // Words already went out: keep what we have instead of starting over.
      if (spoke) return { text: '', model, partial: true };
      errors.push(`${model}: ${err.message}`);
      logger.warn('[rt-llm] model failed, trying next', { model, error: err.message });
    }
  }
  throw new Error(`All voice models failed (${errors.join(' | ')})`);
}

module.exports = { streamReply, toContents };
