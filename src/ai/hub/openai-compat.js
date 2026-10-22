import { classifyProviderError } from './errors.js';

/**
 * OpenAI-compatible provider (OpenAI, OpenRouter, Groq, Mistral, xAI, Custom, LiteLLM, Personal AI Hub).
 * Base URL includes the API root (e.g. .../v1). Paths: /models, /chat/completions.
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

  configured() {
    return Boolean(this.apiKey && this.baseUrl);
  }

  authHeaders() {
    const h = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
      ...this.headers,
    };
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
    try {
      data = JSON.parse(raw);
    } catch {
      return [];
    }
    const list = Array.isArray(data.data) ? data.data : Array.isArray(data) ? data : [];
    return list
      .map((m) => {
        const id = m.id || m.model || m.name;
        if (!id) return null;
        return {
          id: String(id),
          displayName: m.name || id,
          available: true,
          verified: false,
          source: 'list',
          owned_by: m.owned_by || m.provider || null,
        };
      })
      .filter(Boolean);
  }

  async complete({ prompt, system, json = false, model = null, images = [], signal = null, stream = false }) {
    if (!this.configured()) {
      throw Object.assign(new Error(`${this.name} is not configured (base URL + API key required).`), {
        code: 'AI_NEEDS_KEY',
      });
    }
    const use = model || this.model || 'auto';
    if (!use) throw new Error(`No model selected for ${this.name}`);

    const userContent = buildUserContent(prompt, images);
    const body = {
      model: use,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: userContent },
      ],
      temperature: json ? 0.2 : 0.4,
      max_tokens: json ? 8192 : 12288,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    };

    // Some proxies (LiteLLM / local) reject response_format — retry without on 400
    try {
      return await this._chat(body, signal, stream);
    } catch (err) {
      if (body.response_format && (err.status === 400 || /response_format|json_object|unsupported/i.test(String(err.message || '')))) {
        const { response_format, ...rest } = body;
        return this._chat(rest, signal, stream);
      }
      throw err;
    }
  }

  async _chat(body, signal, stream = false) {
    const started = Date.now();
    if (stream) {
      return this._chatStream(body, signal, started);
    }
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify(body),
      signal: signal || AbortSignal.timeout(90000),
    });
    const raw = await res.text();
    if (!res.ok) {
      const cls = classifyProviderError(raw, res.status);
      throw Object.assign(new Error(`${this.name} HTTP ${res.status}: ${cls.user}`), {
        classify: cls,
        status: res.status,
        rawBody: raw.slice(0, 500),
      });
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw Object.assign(new Error(`${this.name} returned invalid JSON`), {
        classify: { code: 'FORMAT', user: 'Provider returned invalid JSON.' },
      });
    }
    return normalizeOpenAIChatResponse(data, {
      provider: this.id,
      model: body.model,
      durationMs: Date.now() - started,
      raw: data,
    });
  }

  /**
   * Minimal SSE stream consumer for OpenAI-compatible proxies (including LiteLLM).
   * Accumulates delta content; aborts cleanly on signal.
   */
  async _chatStream(body, signal, started) {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify({ ...body, stream: true }),
      signal: signal || AbortSignal.timeout(120000),
    });
    if (!res.ok) {
      const raw = await res.text();
      const cls = classifyProviderError(raw, res.status);
      throw Object.assign(new Error(`${this.name} HTTP ${res.status}: ${cls.user}`), {
        classify: cls,
        status: res.status,
      });
    }
    const reader = res.body?.getReader?.();
    if (!reader) {
      // Fallback: non-streaming body
      const raw = await res.text();
      const data = JSON.parse(raw);
      return normalizeOpenAIChatResponse(data, {
        provider: this.id,
        model: body.model,
        durationMs: Date.now() - started,
        raw: data,
      });
    }
    const dec = new TextDecoder();
    let buffer = '';
    let text = '';
    let finishReason = null;
    let model = body.model;
    let usage = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += dec.decode(value, { stream: true });
      const parts = buffer.split('\n');
      buffer = parts.pop() || '';
      for (const line of parts) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const payload = s.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const j = JSON.parse(payload);
          const choice = j.choices?.[0];
          const delta = choice?.delta?.content || choice?.text || '';
          if (delta) text += delta;
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          if (j.model) model = j.model;
          if (j.usage) usage = j.usage;
        } catch {
          /* ignore partial SSE JSON */
        }
      }
    }
    return normalizeOpenAIChatResponse(
      {
        choices: [{ message: { content: text }, finish_reason: finishReason || 'stop' }],
        model,
        usage,
      },
      {
        provider: this.id,
        model,
        durationMs: Date.now() - started,
        streamed: true,
      },
    );
  }
}

function buildUserContent(prompt, images = []) {
  if (!images?.length) return String(prompt || '');
  // OpenAI vision-style multipart content
  const parts = [{ type: 'text', text: String(prompt || '') }];
  for (const img of images.slice(0, 4)) {
    const url = img.dataUrl || img.url;
    if (!url) continue;
    parts.push({ type: 'image_url', image_url: { url } });
  }
  return parts.length > 1 ? parts : String(prompt || '');
}

/**
 * Unified internal schema for OpenAI-compatible chat responses.
 */
export function normalizeOpenAIChatResponse(data, meta = {}) {
  const choice = data?.choices?.[0] || {};
  const message = choice.message || {};
  let text = message.content ?? choice.text ?? data?.output_text ?? '';
  if (Array.isArray(text)) {
    text = text.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
  }
  text = String(text || '');
  const finishRaw = choice.finish_reason || data?.finish_reason || null;
  const finishReason = mapFinishReason(finishRaw);
  const toolCalls = message.tool_calls || choice.tool_calls || null;
  const tokens = Number(data?.usage?.total_tokens || 0) || null;
  if (!text && !toolCalls?.length) {
    if (finishReason === 'BLOCKED') {
      const err = new Error(`${meta.provider || 'provider'} blocked the response`);
      err.finishReason = finishReason;
      err.classify = { code: 'BLOCKED', user: 'Provider blocked the response.' };
      throw err;
    }
    const err = new Error(`${meta.provider || 'provider'} returned an empty response`);
    err.finishReason = finishReason;
    err.classify = { code: 'EMPTY', user: 'Provider returned an empty response.' };
    throw err;
  }
  return {
    provider: meta.provider,
    model: data?.model || meta.model,
    text,
    durationMs: meta.durationMs ?? null,
    tokens,
    finishReason,
    truncated: finishReason === 'LENGTH',
    toolCalls: toolCalls || undefined,
    usage: data?.usage || undefined,
    streamed: Boolean(meta.streamed),
    // Diagnostic only — callers must not log secrets; raw is the provider body without headers
    raw: meta.raw,
  };
}

function mapFinishReason(raw) {
  const s = String(raw || '').toLowerCase();
  if (!s || s === 'stop') return 'STOP';
  if (s === 'length' || s === 'max_tokens') return 'LENGTH';
  if (s === 'content_filter' || s === 'safety') return 'BLOCKED';
  return 'OTHER';
}

/** Strip trailing slash; keep a single /v1 root if present. */
export function normalizeBaseUrl(url) {
  let u = String(url || '').trim().replace(/\/+$/, '');
  u = u.replace(/\/v1\/v1$/i, '/v1');
  return u;
}

export function preferAutoModel(models) {
  const list = Array.isArray(models) ? models : [];
  const auto = list.find((m) => String(m?.id || m || '').toLowerCase() === 'auto');
  return auto ? auto.id || 'auto' : null;
}
