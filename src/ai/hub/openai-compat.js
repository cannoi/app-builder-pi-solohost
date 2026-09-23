import { classifyProviderError } from './errors.js';
import { maskKey } from '../../utils/mask.js';

export class OpenAICompatProvider {
  constructor({ id, name, apiKey, baseUrl, model = '', headers = {} }) {
    this.id = id; this.name = name; this.apiKey = apiKey; this.baseUrl = String(baseUrl || '').replace(/\/+$/, ''); this.model = model; this.headers = headers;
  }
  configured() { return Boolean(this.apiKey && this.baseUrl); }
  authHeaders() { return { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}`, ...this.headers }; }
  async listModels() {
    const res = await fetch(`${this.baseUrl}/models`, { headers: this.authHeaders(), signal: AbortSignal.timeout(20000) });
    const raw = await res.text();
    if (!res.ok) { const cls = classifyProviderError(raw, res.status); throw Object.assign(new Error(`${this.name} ${cls.user}`), { classify: cls, status: res.status }); }
    let data = {}; try { data = JSON.parse(raw); } catch { return []; }
    const list = Array.isArray(data.data) ? data.data : (Array.isArray(data.models) ? data.models : []);
    return list.map((m) => typeof m === 'string' ? { id: m } : ({ id: String(m.id || m.name || ''), contextWindow: m.context_length || m.contextWindow || null, raw: m })).filter((m) => m.id);
  }
  async complete({ prompt, system, json = false, model, images = [] }) {
    if (!this.configured()) throw Object.assign(new Error(`${this.name} API key is not configured`), { classify: { code: 'INVALID_CREDENTIAL', user: 'API key is invalid.' } });
    const use = model || this.model; if (!use) throw new Error(`${this.name} has no verified model yet.`);
    const userContent = images?.length ? [{ type: 'text', text: prompt }, ...images.map((i) => ({ type: 'image_url', image_url: { url: i.dataUrl || i } }))] : prompt;
    const started = Date.now();
    const res = await fetch(`${this.baseUrl}/chat/completions`, { method: 'POST', headers: this.authHeaders(), body: JSON.stringify({ model: use, temperature: json ? 0.2 : 0.4, ...(json ? { response_format: { type: 'json_object' } } : {}), messages: [{ role: 'system', content: system || 'You are a careful senior software architect.' }, { role: 'user', content: userContent }] }), signal: AbortSignal.timeout(120000) });
    const raw = await res.text();
    if (!res.ok) { const cls = classifyProviderError(raw, res.status); throw Object.assign(new Error(`${this.name} HTTP ${res.status}: ${cls.user}`), { classify: cls, status: res.status }); }
    let data; try { data = JSON.parse(raw); } catch { throw new Error(`${this.name} returned invalid JSON`); }
    const text = data.choices?.[0]?.message?.content || ''; if (!text) throw new Error(`${this.name} returned an empty response`);
    return { text, provider: this.id, model: use, durationMs: Date.now() - started, tokens: data.usage?.total_tokens ?? null, rawMeta: { key: maskKey(this.apiKey) } };
  }
}
