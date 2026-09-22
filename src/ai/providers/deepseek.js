import { maskKey } from '../../utils/mask.js';

export function normalizeDeepSeekModel(model) {
  const requested = String(model || '').trim().toLowerCase();
  if (!requested || /^(deepseek-chat|deepseek-reasoner|deepseek-flash)$/i.test(requested)) return 'deepseek-v4-flash';
  if (requested === 'deepseek-v4-pro' || requested === 'deepseek-v4-flash') return requested;
  return String(model).trim();
}

export class DeepSeekProvider {
  constructor({ apiKey, model }) {
    this.name = 'deepseek';
    this.apiKey = apiKey;
    this.model = normalizeDeepSeekModel(model);
  }

  configured() { return Boolean(this.apiKey); }

  async complete({ prompt, system, json = false, images = [] }) {
    if (!this.apiKey) throw new Error('DeepSeek API key is not configured');
    const models = [this.model, 'deepseek-v4-flash', 'deepseek-v4-pro'].filter((value, index, list) => value && list.indexOf(value) === index);
    let lastError = null;
    for (const model of models) {
      try {
        return await this.request(model, { prompt, system, json, images });
      } catch (err) {
        lastError = err;
        // A stale model setting should not make the whole provider unusable.
        if (!/HTTP 400|model|not found|invalid/i.test(String(err.message || err))) throw err;
      }
    }
    throw lastError || new Error('DeepSeek returned no usable model');
  }

  async request(model, { prompt, system, json = false, images = [] }) {
    const started = Date.now();
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model,
        temperature: json ? 0.2 : 0.4,
        response_format: json ? { type: 'json_object' } : undefined,
        messages: [
          { role: 'system', content: system || 'You are a careful senior software architect.' },
          // DeepSeek's text endpoint is intentionally kept text-only. When
          // images are attached, the gateway routes to Gemini first if it is
          // configured instead of sending unsupported image parts here.
          { role: 'user', content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(120000),
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`DeepSeek HTTP ${res.status}: ${raw.slice(0, 500)}`);
    let data;
    try { data = JSON.parse(raw); } catch { throw new Error('DeepSeek returned invalid JSON'); }
    const text = data.choices?.[0]?.message?.content || '';
    if (!text) throw new Error('DeepSeek returned an empty response');
    return {
      text,
      provider: this.name,
      model,
      durationMs: Date.now() - started,
      tokens: data.usage?.total_tokens ?? null,
      rawMeta: { key: maskKey(this.apiKey), imageCount: images?.length || 0 },
    };
  }
}
