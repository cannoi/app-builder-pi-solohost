import { classifyProviderError } from './errors.js';

/**
 * OpenAI-compatible provider (OpenAI, OpenRouter, Groq, Mistral, xAI, Custom, Personal AI Hub).
 * Base URL is expected to already include the API root (e.g. .../v1). Paths are /models and /chat/completions.
 */
export class OpenAICompatProvider {
  constructor({ id, name, apiKey, baseUrl, model = '', headers = {} }) {
    this.id = id;
    this.name = name;
    this.apiKey = apiKey;
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.model = model;
    this.headers = headers || {};
  }

  configured() { return Boolean(this.apiKey && this.baseUrl); }

  authHeaders() {
    const h = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
      ...this.headers,
    };
    // Personal AI Hub and some local gateways also accept this header.
    if (!h['X-Personal-AI-Key']) h['X-Personal-AI-Key'] = this.apiKey;
    return h;
  }

  async listModels() {
    if (!this.baseUrl) return [];
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
    const list = Array.isArray(data.data)
      ? data.data
      : (Array.isArray(data.models) ? data.models : (Array.isArray(data) ? data : []));
    return list
      .map((m) => (typeof m === 'string' ? { id: m } : { id: String(m?.id || m?.name || ''), contextWindow: m?.context_length || m?.contextWindow || null, raw: m }))
      .filter((m) => m.id);
  }

  async complete({ prompt, system, json = false, model, images = [] }) {
    if (!this.configured()) {
      throw Object.assign(new Error(`${this.name} API key is not configured`), {
        classify: { code: 'INVALID_CREDENTIAL', user: 'API key is invalid.' },
      });
    }
    // Prefer explicit model → constructor model → auto (Personal AI Hub / smart routers)
    let use = model || this.model || '';
    if (!use) use = 'auto';
    const userContent = images?.length
      ? [{ type: 'text', text: prompt }, ...images.map((i) => ({ type: 'image_url', image_url: { url: i.dataUrl || i } }))]
      : prompt;
    const started = Date.now();
    const body = {
      model: use,
      temperature: json ? 0.2 : 0.4,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
      messages: [
        { role: 'system', content: system || 'You are a careful senior software architect.' },
        { role: 'user', content: userContent },
      ],
    };
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });
    const raw = await res.text();
    if (!res.ok) {
      const cls = classifyProviderError(raw, res.status);
      throw Object.assign(new Error(`${this.name} HTTP ${res.status}: ${cls.user}`), { classify: cls, status: res.status });
    }
    let data;
    try { data = JSON.parse(raw); } catch {
      throw new Error(`${this.name} returned invalid JSON`);
    }
    const text = data?.choices?.[0]?.message?.content
      || data?.choices?.[0]?.text
      || data?.output_text
      || '';
    const tokens = Number(data?.usage?.total_tokens || 0) || null;
    return {
      provider: this.id,
      model: use,
      text: String(text || ''),
      durationMs: Date.now() - started,
      tokens,
      raw: data,
    };
  }
}

/** Strip trailing slash; keep a single /v1 root if present. Never append /v1 again at call sites. */
export function normalizeBaseUrl(url) {
  let u = String(url || '').trim().replace(/\/+$/, '');
  // Collapse accidental .../v1/v1
  u = u.replace(/\/v1\/v1$/i, '/v1');
  return u;
}

/** Prefer gateway "auto" when the hub advertises it. */
export function preferAutoModel(models) {
  const list = Array.isArray(models) ? models : [];
  const auto = list.find((m) => String(m?.id || m || '').toLowerCase() === 'auto');
  return auto ? (auto.id || 'auto') : null;
}
