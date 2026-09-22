import { PROVIDER_CATALOG, catalogEntry, taskComplexity } from './catalog.js';
import { OpenAICompatProvider } from './openai-compat.js';
import { GeminiProvider } from '../providers/gemini.js';
import { DeepSeekProvider } from '../providers/deepseek.js';
import { classifyProviderError, isTransient } from './errors.js';
import { maskKey } from '../../utils/mask.js';

const CACHE_MS = 6 * 60 * 60 * 1000;

export class AIProviderHub {
  constructor({ cfg, db, log }) {
    this.cfg = cfg;
    this.db = db;
    this.log = log;
    this.migrateLegacy();
  }

  state() {
    return this.db.setting('aiHub', {
      mode: 'AUTO',
      preferredProvider: 'AUTO',
      preferredModel: 'AUTO',
      connections: [],
    }) || { mode: 'AUTO', preferredProvider: 'AUTO', preferredModel: 'AUTO', connections: [] };
  }

  save(next) { this.db.setSetting('aiHub', next); return next; }

  migrateLegacy() {
    const st = this.state();
    if (!Array.isArray(st.connections)) st.connections = [];
    const add = (id, key, model) => {
      if (!key) return;
      if (st.connections.some((c) => c.provider === id && c.apiKey === key)) return;
      st.connections.push({
        id: `${id}-legacy`,
        provider: id,
        apiKey: key,
        baseUrl: catalogEntry(id)?.baseUrl || '',
        status: 'UNVERIFIED',
        models: model ? [{ id: model, verified: false }] : [],
        mode: 'AUTO',
        lastError: null,
        lastVerified: null,
      });
    };
    add('deepseek', this.cfg.ai.deepseekKey, this.cfg.ai.deepseekModel);
    add('gemini', this.cfg.ai.geminiKey, this.cfg.ai.geminiModel);
    if (!st.mode) st.mode = 'AUTO';
    this.save(st);
  }

  publicState() {
    const st = this.state();
    return {
      mode: st.mode || 'AUTO',
      preferredProvider: st.preferredProvider || 'AUTO',
      preferredModel: st.preferredModel || 'AUTO',
      catalog: PROVIDER_CATALOG.map(({ id, name, kind }) => ({ id, name, kind })),
      connections: (st.connections || []).map((c) => ({
        id: c.id,
        provider: c.provider,
        name: catalogEntry(c.provider)?.name || c.provider,
        masked: maskKey(c.apiKey),
        status: c.status || 'UNVERIFIED',
        models: (c.models || []).map((m) => m.id || m),
        verifiedCount: (c.models || []).filter((m) => m.verified !== false).length,
        lastError: c.lastError,
        lastVerified: c.lastVerified,
        baseUrl: c.provider === 'custom' ? c.baseUrl : undefined,
      })),
    };
  }

  adapter(conn) {
    const meta = catalogEntry(conn.provider) || catalogEntry('custom');
    if (conn.provider === 'gemini') {
      return new GeminiProvider({ apiKey: conn.apiKey, model: conn.models?.[0]?.id || this.cfg.ai.geminiModel, db: this.db, log: this.log });
    }
    if (conn.provider === 'deepseek') {
      return new DeepSeekProvider({ apiKey: conn.apiKey, model: conn.models?.[0]?.id || this.cfg.ai.deepseekModel });
    }
    if (conn.provider === 'anthropic') return new AnthropicAdapter(conn);
    return new OpenAICompatProvider({
      id: conn.provider,
      name: meta?.name || conn.provider,
      apiKey: conn.apiKey,
      baseUrl: conn.baseUrl || meta?.baseUrl,
      model: conn.models?.[0]?.id || '',
    });
  }

  async testConnection({ provider, apiKey, baseUrl, model }) {
    const conn = {
      id: 'probe',
      provider,
      apiKey,
      baseUrl: baseUrl || catalogEntry(provider)?.baseUrl || '',
      models: model ? [{ id: model, verified: false }] : [],
    };
    const models = await this.discover(conn);
    return { ok: true, models };
  }

  async discover(conn) {
    const meta = catalogEntry(conn.provider) || {};
    const adapter = this.adapter(conn);
    let names = [];
    try {
      if (typeof adapter.listModels === 'function' && meta.discover !== false) {
        const raw = await adapter.listModels();
        names = (raw || []).map((m) => (typeof m === 'string' ? m : (m.id || m.name || ''))).map((n) => String(n).replace(/^models\//, '')).filter(Boolean);
      }
    } catch (err) {
      const cls = err.classify || classifyProviderError(err);
      if (cls.code === 'INVALID_CREDENTIAL') throw err;
    }
    if (!names.length) names = [...(meta.fallbackModels || []), ...(conn.models || []).map((m) => m.id)].filter(Boolean);
    const unique = [...new Set(names)].slice(0, 24);
    return unique.map((id) => ({
      id,
      displayName: id,
      available: true,
      verified: true,
      capabilities: guessCaps(id),
      lastVerified: new Date().toISOString(),
      source: names.includes(id) ? 'discovery' : 'documented-fallback',
    }));
  }

  upsertConnection(input) {
    const st = this.state();
    const id = input.id || `${input.provider}-${Date.now().toString(36)}`;
    const next = {
      id,
      provider: input.provider,
      apiKey: input.apiKey,
      baseUrl: input.baseUrl || catalogEntry(input.provider)?.baseUrl || '',
      status: input.status || 'UNVERIFIED',
      models: input.models || [],
      lastError: input.lastError || null,
      lastVerified: input.lastVerified || null,
      mode: 'AUTO',
    };
    const idx = st.connections.findIndex((c) => c.id === id || (c.provider === input.provider && c.provider !== 'custom'));
    if (idx >= 0) {
      if (!next.apiKey) next.apiKey = st.connections[idx].apiKey;
      st.connections[idx] = { ...st.connections[idx], ...next };
    } else st.connections.push(next);
    this.syncLegacyKeys(st);
    return this.save(st);
  }

  removeConnection(id) {
    const st = this.state();
    st.connections = (st.connections || []).filter((c) => c.id !== id);
    this.syncLegacyKeys(st);
    return this.save(st);
  }

  setRouting({ mode, preferredProvider, preferredModel }) {
    const st = this.state();
    if (mode) st.mode = mode;
    if (preferredProvider) st.preferredProvider = preferredProvider;
    if (preferredModel) st.preferredModel = preferredModel;
    return this.save(st);
  }

  syncLegacyKeys(st) {
    const ds = (st.connections || []).find((c) => c.provider === 'deepseek' && c.apiKey);
    const gm = (st.connections || []).find((c) => c.provider === 'gemini' && c.apiKey);
    if (ds) {
      this.cfg.ai.deepseekKey = ds.apiKey;
      process.env.DEEPSEEK_API_KEY = ds.apiKey;
      if (ds.models?.[0]?.id) this.cfg.ai.deepseekModel = ds.models[0].id;
    }
    if (gm) {
      this.cfg.ai.geminiKey = gm.apiKey;
      process.env.GEMINI_API_KEY = gm.apiKey;
      if (gm.models?.[0]?.id) this.cfg.ai.geminiModel = gm.models[0].id;
    }
    const preferred = st.preferredProvider && st.preferredProvider !== 'AUTO' ? st.preferredProvider : null;
    if (preferred === 'gemini' || preferred === 'deepseek') this.cfg.ai.provider = preferred;
  }

  candidates(task) {
    const st = this.state();
    const level = taskComplexity(task);
    let list = (st.connections || []).filter((c) => c.apiKey && (c.status === 'VERIFIED' || (c.models || []).length));
    if (st.mode === 'PROVIDER' && st.preferredProvider && st.preferredProvider !== 'AUTO') {
      list = list.filter((c) => c.provider === st.preferredProvider);
    }
    const out = [];
    for (const conn of list) {
      const models = (conn.models || []).length ? conn.models : [{ id: catalogEntry(conn.provider)?.fallbackModels?.[0], verified: true }];
      for (const model of models) {
        if (!model?.id) continue;
        if (st.mode === 'MANUAL' && st.preferredModel && st.preferredModel !== 'AUTO' && model.id !== st.preferredModel) continue;
        out.push({ conn, model: model.id, score: scoreModel(model.id, level) });
      }
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  async execute({ task, prompt, system, json = false, images = [] }) {
    const picks = this.candidates(task);
    if (!picks.length) {
      throw Object.assign(new Error('No verified AI connection is available. Add a provider in Settings.'), { code: 'AI_UNAVAILABLE' });
    }
    const errors = [];
    let tries = 0;
    for (const pick of picks) {
      if (tries >= 4) break;
      tries += 1;
      const adapter = this.adapter(pick.conn);
      try {
        if (pick.conn.provider === 'gemini' && typeof adapter.complete === 'function') {
          return await adapter.complete({ prompt, system, json, images });
        }
        if (pick.conn.provider === 'deepseek') {
          return await adapter.complete({ prompt, system, json, images });
        }
        return await adapter.complete({ prompt, system, json, model: pick.model });
      } catch (err) {
        const cls = err.classify || classifyProviderError(err);
        errors.push(`${pick.conn.provider}/${pick.model}: ${cls.user}`);
        if (cls.code === 'INVALID_CREDENTIAL') {
          this.markError(pick.conn.id, cls.user, 'INVALID');
          continue;
        }
        if (!isTransient(cls.code) && cls.code !== 'MODEL_OR_ENDPOINT_UNAVAILABLE') {
          continue;
        }
      }
    }
    throw Object.assign(new Error(errors.join(' | ') || 'No AI provider is configured'), { code: 'AI_UNAVAILABLE', providerErrors: errors });
  }

  markError(id, message, status = 'ERROR') {
    const st = this.state();
    const row = st.connections.find((c) => c.id === id);
    if (!row) return;
    row.lastError = message;
    if (status === 'INVALID') row.status = 'INVALID';
    this.save(st);
  }
}

function guessCaps(id) {
  const n = String(id).toLowerCase();
  return {
    chat: true,
    text_generation: true,
    coding: /code|gpt|claude|gemini|deepseek|grok|llama|mistral|qwen/.test(n) ? true : 'unknown',
    reasoning: /reason|think|pro|opus|sonnet|o1|o3|grok/.test(n) ? true : 'unknown',
    vision: /vision|gpt-4o|gemini|claude|grok/.test(n) ? true : 'unknown',
    tools: 'unknown',
    streaming: 'unknown',
    structured_output: 'unknown',
  };
}

function scoreModel(id, level) {
  const n = String(id).toLowerCase();
  let s = 50;
  if (level === 'high' && /pro|reason|opus|sonnet|gpt-4|grok-4|deepseek-v4-pro/.test(n)) s += 20;
  if (level === 'low' && /flash|mini|haiku|small|lite/.test(n)) s += 15;
  if (/preview|exp/.test(n)) s -= 5;
  return s;
}

class AnthropicAdapter {
  constructor(conn) {
    this.conn = conn;
    this.name = 'anthropic';
  }
  configured() { return Boolean(this.conn.apiKey); }
  async listModels() { return catalogEntry('anthropic').fallbackModels; }
  async complete({ prompt, system, json = false, model }) {
    const use = model || this.conn.models?.[0]?.id || 'claude-sonnet-4-5';
    const started = Date.now();
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.conn.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: use,
        max_tokens: 4096,
        system: system || undefined,
        messages: [{ role: 'user', content: json ? `${prompt}\nReturn JSON only.` : prompt }],
      }),
      signal: AbortSignal.timeout(120000),
    });
    const raw = await res.text();
    if (!res.ok) {
      const cls = classifyProviderError(raw, res.status);
      throw Object.assign(new Error(`Anthropic HTTP ${res.status}: ${cls.user}`), { classify: cls, status: res.status });
    }
    const data = JSON.parse(raw);
    const text = (data.content || []).map((p) => p.text || '').join('\n');
    if (!text) throw new Error('Anthropic returned an empty response');
    return { text, provider: 'anthropic', model: use, durationMs: Date.now() - started, tokens: data.usage?.input_tokens + data.usage?.output_tokens || null, rawMeta: { key: maskKey(this.conn.apiKey) } };
  }
}
