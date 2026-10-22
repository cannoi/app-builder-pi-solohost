/**
 * LiteLLM-style unified AI layer (always on).
 *
 * - Default: in-process normalization of every provider response to one schema.
 * - Optional: if LITELLM_BASE_URL (or LITELLM_URL) is set, all completions
 *   go through that OpenAI-compatible proxy (real LiteLLM). Keys stay server-side.
 *
 * Not a Settings "provider" — it is the standard call path for Builder.
 */
import { OpenAICompatProvider, normalizeOpenAIChatResponse, normalizeBaseUrl } from './hub/openai-compat.js';
import { classifyProviderError } from './hub/errors.js';

export function litellmBaseUrl() {
  const u = process.env.LITELLM_BASE_URL || process.env.LITELLM_URL || '';
  return normalizeBaseUrl(u);
}

export function litellmEnabled() {
  return Boolean(litellmBaseUrl());
}

export function litellmApiKey() {
  return process.env.LITELLM_API_KEY || process.env.LITELLM_MASTER_KEY || '';
}

/**
 * Map Builder provider + model → LiteLLM model id when using external proxy.
 * e.g. gemini + gemini-2.0-flash → gemini/gemini-2.0-flash
 */
export function toLiteLLMModelId(provider, model) {
  const p = String(provider || '').toLowerCase();
  const m = String(model || '').trim();
  if (!m) return p === 'gemini' ? 'gemini/gemini-2.0-flash' : 'auto';
  if (m.includes('/')) return m;
  if (p === 'gemini') return `gemini/${m}`;
  if (p === 'deepseek') return `deepseek/${m}`;
  if (p === 'openai') return m;
  if (p === 'anthropic') return m.startsWith('claude') ? m : `anthropic/${m}`;
  if (p === 'openrouter') return m;
  return m;
}

/**
 * Normalize any provider result into the internal schema (LiteLLM/OpenAI-shaped).
 */
export function normalizeAiResult(result, fallbackProvider = 'unknown') {
  if (!result || typeof result !== 'object') {
    return {
      provider: fallbackProvider,
      model: null,
      text: String(result || ''),
      durationMs: null,
      tokens: null,
      finishReason: 'OTHER',
      normalized: true,
      via: 'litellm-layer',
    };
  }
  // Already normalized
  if (result.normalized || result.finishReason) {
    return {
      ...result,
      provider: result.provider || fallbackProvider,
      text: String(result.text || ''),
      normalized: true,
      via: result.via || 'litellm-layer',
    };
  }
  // OpenAI-like raw
  if (result.choices || result.usage) {
    try {
      const n = normalizeOpenAIChatResponse(result, {
        provider: result.provider || fallbackProvider,
        model: result.model,
        durationMs: result.durationMs,
        raw: result.raw || result,
      });
      return { ...n, normalized: true, via: 'litellm-layer' };
    } catch (err) {
      throw err;
    }
  }
  return {
    provider: result.provider || fallbackProvider,
    model: result.model || null,
    text: String(result.text || ''),
    durationMs: result.durationMs ?? null,
    tokens: result.tokens ?? null,
    finishReason: result.truncated ? 'LENGTH' : (result.finishReason || 'STOP'),
    truncated: Boolean(result.truncated),
    normalized: true,
    via: 'litellm-layer',
    raw: result.raw,
  };
}

/**
 * External LiteLLM proxy client (only when LITELLM_BASE_URL is set).
 */
export function createLiteLLMProxyClient({ apiKey, baseUrl, defaultModel = 'auto' } = {}) {
  const url = normalizeBaseUrl(baseUrl || litellmBaseUrl());
  const key = apiKey || litellmApiKey();
  if (!url) return null;
  return new OpenAICompatProvider({
    id: 'litellm',
    name: 'LiteLLM',
    apiKey: key || 'sk-no-key',
    baseUrl: url,
    model: defaultModel,
  });
}

/**
 * List models from external LiteLLM when configured; otherwise null (caller uses hub discover).
 */
export async function listLiteLLMModels() {
  const client = createLiteLLMProxyClient();
  if (!client || !client.configured()) return null;
  try {
    return await client.listModels();
  } catch (err) {
    const cls = err.classify || classifyProviderError(err, err.status || 0);
    throw Object.assign(err, { classify: cls });
  }
}

/**
 * Complete via external LiteLLM if enabled; returns null to signal "use direct provider path".
 */
export async function completeViaLiteLLMProxy(opts = {}) {
  const client = createLiteLLMProxyClient({
    defaultModel: opts.model || 'auto',
  });
  if (!client || !client.apiKey || client.apiKey === 'sk-no-key') {
    // Proxy URL set but no key — still try (some proxies allow no auth on LAN)
    if (!litellmBaseUrl()) return null;
  }
  if (!litellmEnabled()) return null;
  const model = opts.model || client.model || 'auto';
  const result = await client.complete({
    prompt: opts.prompt,
    system: opts.system,
    json: opts.json,
    model,
    images: opts.images,
    signal: opts.signal,
    stream: opts.stream,
  });
  return normalizeAiResult(result, 'litellm');
}
