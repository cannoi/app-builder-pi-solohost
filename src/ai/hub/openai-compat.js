import { classifyProviderError } from './errors.js';
import { maskKey } from '../../utils/mask.js';

export class OpenAICompatProvider {
  constructor({ id, name, apiKey, baseUrl, model = '', headers = {} }) {
    this.id = id;
    this.name = name;
    this.apiKey = apiKey;
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.model = model;
    this.headers = headers;
  }

  configured() { return Boolean(this.apiKey && this.baseUrl); }

  authHeaders() {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
      ...this.headers,
    };
  }

  async listModels() {
    const res = await fetch(`${this.baseUrl}/models`, {
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(20000),
    });
    const raw = await res.text();
    if (!res.ok) {
      const cls = classifyProviderError(raw, res.status);
      throw Object.assign(new Error(`${this.name} ${cls.user}`), { classify: cls, status: res.status });
    }
    let data = {};
    try { data = JSON.parse(raw); } catch { return []; }
    const list = Array.isArray(data.data) ? data.data : (Array.isArray(data.models) ? data.models : []);
    return list.map((m) => String(m.id || m.name || '')).filter(Boolean);
  }

  async complete({ prompt, system, json = false, model }) {
    if (!this.configured()) throw new Error(`${this.name} API key is not configured`);
    const use = model || this.model;
    if (!use) throw new Error(`${this.name} has no verified model yet.`);
    const started = Date.now();
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify({
        model: use,
        temperature: json ? 0.2 : 0.4,
        response_format: json ? { type: 'json_object' } : undefined,
        messages: [
          { role: 'system', content: system || 'You are a careful senior software architect.' },
          { role: 'user', content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(120000),
    });
    const raw = await res.text();
    if (!res.ok) {
      const cls = classifyProviderError(raw, res.status);
      throw Object.assign(new Error(`${this.name} HTTP ${res.status}: ${cls.user}`), { classify: cls, status: res.status });
    }
    let data;
    try { data = JSON.parse(raw); } catch { throw new Error(`${this.name} returned invalid JSON`); }
    const text = data.choices?.[0]?.message?.content || '';
    if (!text) throw new Error(`${this.name} returned an empty response`);
    return {
      text,
      provider: this.id,
      model: use,
      durationMs: Date.now() - started,
      tokens: data.usage?.total_tokens ?? null,
      rawMeta: { key: maskKey(this.apiKey) },
    };
  }
}
