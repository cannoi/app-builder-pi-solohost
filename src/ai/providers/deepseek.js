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

  async listModels() {
    if (!this.apiKey) throw new Error('DeepSeek API key is not configured');
    const res = await fetch('https://api.deepseek.com/models', {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(20000),
    });
    const raw = await res.text();
    if (!res.ok) {
      const error = new Error(`DeepSeek HTTP ${res.status}: ${raw.slice(0, 300)}`);
      error.status = res.status;
      throw error;
    }
    const data = JSON.parse(raw);
    return Array.isArray(data.data) ? data.data.map((m) => ({ id: m.id, contextWindow: m.context_length || null })) : [];
  }

  async complete({ prompt, system, json = false, images = [], signal = null, timeoutMs = 0 }) {
    if (!this.apiKey) throw new Error('DeepSeek API key is not configured');
    const model = this.model || 'deepseek-chat';
    return await this.request(model, { prompt, system, json, images, signal, timeoutMs });
  }

  async request(model, { prompt, system, json = false, images = [], signal = null, timeoutMs = 0 } = {}) {
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
      signal: (() => { const t = AbortSignal.timeout(timeoutMs > 0 ? timeoutMs : 60000); return signal ? AbortSignal.any([t, signal]) : t; })(),
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
      finishReason: data.choices?.[0]?.finish_reason || null,
      rawMeta: { key: maskKey(this.apiKey), imageCount: images?.length || 0 },
    };
  }
}
