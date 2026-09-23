import { PROVIDER_CATALOG, catalogEntry, taskComplexity } from './catalog.js';
import { OpenAICompatProvider } from './openai-compat.js';
import { GeminiProvider } from '../providers/gemini.js';
import { DeepSeekProvider } from '../providers/deepseek.js';
import { classifyProviderError, isTransient } from './errors.js';
import { maskKey } from '../../utils/mask.js';
import { CredentialVault } from './credentials.js';

const CACHE_MS = 6 * 60 * 60 * 1000;

export class AIProviderHub {
  constructor({ cfg, db, log }) {
    this.cfg = cfg; this.db = db; this.log = log;
    this.vault = new CredentialVault(cfg.dataDir);
    this.migrateLegacy();
  }

  state() {
    const raw = this.db.setting('aiHub', { mode: 'SELECTED', preferredProvider: '', preferredModel: '', preferredModels: [], connections: [] })
      || { mode: 'SELECTED', preferredProvider: '', preferredModel: '', preferredModels: [], connections: [] };
    return normalizeHubState(raw);
  }
  save(next) { this.db.setSetting('aiHub', next); return next; }

  migrateLegacy() {
    const st = this.state();
    if (!Array.isArray(st.connections)) st.connections = [];
    const migrate = (id, key, model) => {
      if (!key || st.connections.some((c) => c.provider === id)) return;
      const ref = `${id}-legacy`;
      this.vault.set(ref, key);
      st.connections.push({ id: ref, provider: id, credentialRef: ref, baseUrl: catalogEntry(id)?.baseUrl || '', status: 'UNVERIFIED', models: model ? [{ id: model, verified: false }] : [], lastError: null, lastVerified: null, cacheAt: null });
    };
    migrate('deepseek', this.cfg.ai.deepseekKey, this.cfg.ai.deepseekModel);
    migrate('gemini', this.cfg.ai.geminiKey, this.cfg.ai.geminiModel);
    // Remove any legacy plaintext apiKey fields from the hub state after migration.
    let changed = false;
    for (const c of st.connections) {
      if (c.apiKey) { if (!c.credentialRef) { c.credentialRef = c.id; this.vault.set(c.credentialRef, c.apiKey); } delete c.apiKey; changed = true; }
    }
    if (!st.mode) st.mode = 'AUTO';
    if (changed || st.connections.length) this.save(st);
    const secrets = this.db.setting('runtimeSecrets', null);
    if (secrets && typeof secrets === 'object') {
      let dirty = false;
      for (const k of ['GEMINI_API_KEY', 'GEMINI_MODEL', 'DEEPSEEK_API_KEY', 'DEEPSEEK_MODEL']) {
        if (k in secrets) { delete secrets[k]; dirty = true; }
      }
      if (dirty) this.db.setSetting('runtimeSecrets', secrets);
    }
  }

  key(conn) { return conn?.credentialRef ? this.vault.get(conn.credentialRef) : ''; }

  publicState() {
    const st = this.state();
    return {
      mode: 'SELECTED', preferredProvider: st.preferredProvider || '', preferredModel: st.preferredModel || '', preferredModels: normalizePreferredModels(st.preferredModels || (st.preferredModel ? [st.preferredModel] : [])),
      catalog: PROVIDER_CATALOG.map(({ id, name, kind }) => ({ id, name, kind })),
      connections: (st.connections || []).map((c) => ({
        id: c.id, provider: c.provider, name: catalogEntry(c.provider)?.name || c.provider,
        credentialRef: c.credentialRef, masked: maskKey(this.key(c)), status: c.status || 'UNVERIFIED',
        models: normalizeModelsState(c.models).map((m) => ({ id: m.id || m, verified: m.verified === true, capabilities: m.capabilities || {}, contextWindow: m.contextWindow || null, lastVerified: m.lastVerified || null })),
        verifiedCount: normalizeModelsState(c.models).filter((m) => m.verified === true).length,
        lastError: c.lastError || null, lastVerified: c.lastVerified || null, baseUrl: c.provider === 'custom' ? c.baseUrl : undefined,
      })),
    };
  }

  adapter(conn) {
    const meta = catalogEntry(conn.provider) || catalogEntry('custom');
    const apiKey = this.key(conn);
    if (conn.provider === 'gemini') return new GeminiProvider({ apiKey, model: firstModel(conn), db: this.db, log: this.log });
    if (conn.provider === 'deepseek') return new DeepSeekProvider({ apiKey, model: firstModel(conn) });
    if (conn.provider === 'anthropic') return new AnthropicAdapter({ ...conn, apiKey });
    return new OpenAICompatProvider({ id: conn.provider, name: meta?.name || conn.provider, apiKey, baseUrl: conn.baseUrl || meta?.baseUrl, model: firstModel(conn) });
  }

  async testConnection({ provider, apiKey, baseUrl, model }) {
    const id = `${provider}-probe-${Date.now().toString(36)}`;
    const ref = `${id}-credential`;
    this.vault.set(ref, apiKey);
    const fallback = (catalogEntry(provider)?.fallbackModels || []).map((mid) => ({ id: mid, displayName: mid, available: true, verified: false, capabilities: normalizeCaps({}, mid, provider), source: 'documented-fallback' }));
    const conn = { id, provider, credentialRef: ref, baseUrl: baseUrl || catalogEntry(provider)?.baseUrl || '', models: model ? [{ id: model, verified: false }] : fallback };
    try {
      let discovered = [];
      try {
        discovered = await this.discover(conn, { force: true, allowFallback: true });
      } catch (err) {
        const cls = err.classify || classifyProviderError(err);
        if (cls.code === 'INVALID_CREDENTIAL') throw err;
      }
      if (!Array.isArray(discovered)) discovered = [];
      if (!discovered.length && model) discovered.push({ id: model, displayName: model, available: true, verified: false, capabilities: normalizeCaps({}, model, provider), source: 'manual' });
      if (!discovered.length) discovered = fallback;
      if (!discovered.length) throw Object.assign(new Error('No usable model is known for this provider. Paste the key and try again.'), { code: 'MODEL_OR_ENDPOINT_UNAVAILABLE', classify: { code: 'MODEL_OR_ENDPOINT_UNAVAILABLE', user: 'No usable model is known for this provider.' } });
      const probeId = model || selectProbeModel(discovered) || discovered[0].id;
      const result = await this.probeModel(conn, probeId);
      if (result.ok) {
        const models = discovered.map((m) => ({ ...m, verified: m.id === probeId, lastVerified: m.id === probeId ? new Date().toISOString() : null }));
        return { ok: true, models, verifiedModel: probeId };
      }
      const cls = result.error?.classify || classifyProviderError(result.error);
      if (cls.code === 'INVALID_CREDENTIAL') throw result.error;
      // Key may still work on a later request. Keep models usable so chat does not stall.
      const models = discovered.map((m, i) => ({ ...m, verified: i === 0 || m.id === probeId, lastVerified: null }));
      return { ok: true, models, verifiedModel: models[0]?.id || probeId, warning: cls.user };
    } finally {
      this.vault.remove(ref);
    }
  }

  async discover(conn, { force = false, allowFallback = false } = {}) {
    const st = this.state();
    const stored = st.connections.find((c) => c.id === conn.id);
    if (!force && stored?.cacheAt && Date.now() - Date.parse(stored.cacheAt) < CACHE_MS && Array.isArray(stored.models)) return stored.models;
    const meta = catalogEntry(conn.provider) || {};
    const adapter = this.adapter(conn);
    let raw = [];
    try {
      if (typeof adapter.listModels === 'function' && meta.discover !== false) raw = await adapter.listModels();
      else if (conn.models?.length) raw = conn.models;
    } catch (err) {
      const cls = err.classify || classifyProviderError(err);
      if (cls.code === 'INVALID_CREDENTIAL' || cls.code === 'PERMISSION_DENIED') throw Object.assign(err, { classify: cls });
      if (!allowFallback) return [];
    }
    const models = normalizeModels(raw, conn.provider);
    if (!models.length && allowFallback && conn.models?.length) return normalizeModels(conn.models, conn.provider);
    return models;
  }

  async probeModel(conn, modelId) {
    const adapter = this.adapter({ ...conn, models: [{ id: modelId }] });
    try {
      const result = await adapter.complete({ prompt: 'Reply with exactly: OK', system: 'Connection verification. Do not perform any other task.', json: false, model: modelId, images: [] });
      if (!result?.text) throw new Error('Empty model verification response.');
      return { ok: true, result };
    } catch (err) {
      const cls = err.classify || classifyProviderError(err);
      return { ok: false, error: Object.assign(new Error(cls.user || err.message), { classify: cls, cause: err }) };
    }
  }

  upsertConnection(input) {
    const st = this.state();
    const id = input.id || `${input.provider}-${Date.now().toString(36)}`;
    const ref = input.credentialRef || `${id}-credential`;
    if (input.apiKey) this.vault.set(ref, input.apiKey);
    const next = { id, provider: input.provider, credentialRef: ref, baseUrl: input.baseUrl || catalogEntry(input.provider)?.baseUrl || '', status: input.status || 'UNVERIFIED', models: normalizeModelsState(input.models), lastError: input.lastError || null, lastVerified: input.lastVerified || null, cacheAt: input.cacheAt || new Date().toISOString() };
    const idx = st.connections.findIndex((c) => c.id === id || (c.provider === input.provider && c.provider !== 'custom'));
    if (idx >= 0) st.connections[idx] = { ...st.connections[idx], ...next };
    else st.connections.push(next);
    this.syncLegacyKeys(st);
    return this.save(st);
  }

  removeConnection(id) {
    const st = this.state(); const row = st.connections.find((c) => c.id === id);
    if (row?.credentialRef) this.vault.remove(row.credentialRef);
    st.connections = (st.connections || []).filter((c) => c.id !== id); this.syncLegacyKeys(st); return this.save(st);
  }

  setRouting({ preferredProvider, preferredModel, preferredModels }) {
    const st = this.state();
    st.mode = 'SELECTED';
    if (preferredProvider != null) st.preferredProvider = String(preferredProvider || '');
    const pair = normalizePreferredModels(preferredModels || (preferredModel ? [preferredModel] : st.preferredModels));
    st.preferredModels = pair.slice(0, 2);
    st.preferredModel = st.preferredModels[0] || '';
    return this.save(st);
  }

  selectedModels() { return normalizePreferredModels(this.state().preferredModels || []); }

  syncLegacyKeys(st) {
    for (const c of st.connections || []) c.models = normalizeModelsState(c.models);
    const ds = st.connections.find((c) => c.provider === 'deepseek' && this.key(c));
    const gm = st.connections.find((c) => c.provider === 'gemini' && this.key(c));
    this.cfg.ai.deepseekKey = ds ? this.key(ds) : '';
    this.cfg.ai.geminiKey = gm ? this.key(gm) : '';
    const dsModels = normalizeModelsState(ds?.models);
    const gmModels = normalizeModelsState(gm?.models);
    if (dsModels.find((m) => m.verified)?.id) this.cfg.ai.deepseekModel = dsModels.find((m) => m.verified).id;
    if (gmModels.find((m) => m.verified)?.id) this.cfg.ai.geminiModel = gmModels.find((m) => m.verified).id;
    const preferred = st.preferredProvider || '';
    this.cfg.ai.provider = preferred || ds?.provider || gm?.provider || st.connections?.[0]?.provider || 'deepseek';
  }

  candidates(task, modelRef = '') {
    const st = this.state(); const level = taskComplexity(task);
    let list = (st.connections || []).filter((c) => this.key(c) && c.status !== 'INVALID');
    const selected = normalizePreferredModels(st.preferredModels || []);
    if (selected.length) {
      const filtered = list.filter((c) => selected.some((ref) => ref.startsWith(`${c.provider}:`) || ref.startsWith(`${c.id}:`) || ref === c.provider));
      if (filtered.length) list = filtered;
    } else if (st.preferredProvider && st.preferredProvider !== 'AUTO') {
      const locked = list.filter((c) => c.provider === st.preferredProvider);
      if (locked.length) list = locked;
    }
    const out = [];
    for (const conn of list) {
      let models = normalizeModelsState(conn.models);
      if (!models.length) models = (catalogEntry(conn.provider)?.fallbackModels || []).map((id) => ({ id, verified: true }));
      const verified = models.filter((m) => m.verified === true);
      const usable = verified.length ? verified : models;
      for (const model of usable) {
        if (!model?.id) continue;
        const ref = `${conn.provider}:${model.id}`;
        const legacyRef = `${conn.id}:${model.id}`;
        if (modelRef && modelRef !== ref && modelRef !== legacyRef) continue;
        if (selected.length && !selected.includes(ref) && !selected.includes(legacyRef) && !selected.includes(model.id)) continue;
        out.push({ conn, model: model.id, ref, score: scoreModel(model, level) });
      }
    }
    if (!out.length) {
      for (const conn of list) {
        const models = normalizeModelsState(conn.models);
        const first = models[0] || (catalogEntry(conn.provider)?.fallbackModels || []).map((id) => ({ id }))[0];
        if (first?.id) out.push({ conn, model: first.id, ref: `${conn.provider}:${first.id}`, score: 1 });
      }
    }
    const added = new Map((st.connections || []).map((c, i) => [c.id, st.connections.length - i]));
    const rank = new Map(selected.map((ref, i) => [ref, selected.length - i]));
    return out.sort((a, b) => (rank.get(b.ref) || 0) - (rank.get(a.ref) || 0) || (added.get(b.conn.id) || 0) - (added.get(a.conn.id) || 0) || b.score - a.score);
  }

  async execute({ task, prompt, system, json = false, images = [], modelRef = '' }) {
    const picks = this.candidates(task, modelRef);
    if (!picks.length) throw Object.assign(new Error('No verified AI model is available for this task. Connect a provider or refresh its models.'), { code: 'AI_UNAVAILABLE' });
    const errors = []; let tries = 0;
    for (const pick of picks) {
      if (tries >= 4) break;
      tries += 1;
      try {
        const adapter = this.adapter({ ...pick.conn, models: [{ id: pick.model }] });
        const result = await adapter.complete({ prompt, system, json, model: pick.model, images });
        this.markModelVerified(pick.conn.id, pick.model, result);
        return result;
      } catch (err) {
        const cls = err.classify || classifyProviderError(err); errors.push(`${pick.conn.provider}/${pick.model}: ${cls.user}`);
        this.markError(pick.conn.id, cls.user, cls.code === 'INVALID_CREDENTIAL' ? 'INVALID' : 'ERROR');
        if (cls.code === 'INVALID_CREDENTIAL') break;
        if (!isTransient(cls.code) && cls.code !== 'MODEL_OR_ENDPOINT_UNAVAILABLE') continue;
      }
    }
    throw Object.assign(new Error(errors.join(' | ') || 'No verified AI model is available'), { code: 'AI_UNAVAILABLE', providerErrors: errors });
  }

  markModelVerified(connectionId, modelId, result) {
    const st = this.state(); const row = st.connections.find((c) => c.id === connectionId); if (!row) return;
    row.models = normalizeModelsState(row.models);
    const m = row.models.find((x) => (x.id || x) === modelId); if (m && typeof m === 'object') { m.verified = true; m.lastVerified = new Date().toISOString(); }
    row.status = 'VERIFIED'; row.lastVerified = new Date().toISOString(); row.lastError = null; row.cacheAt = new Date().toISOString(); this.save(st);
  }

  markError(id, message, status = 'ERROR') {
    const st = this.state(); const row = st.connections.find((c) => c.id === id); if (!row) return;
    row.lastError = String(message || '').slice(0, 240); if (status === 'INVALID') row.status = 'INVALID'; this.save(st);
  }
}

function normalizeModelsState(models) {
  if (Array.isArray(models)) return models.map((m) => typeof m === 'string' ? { id: m, verified: false } : (m && typeof m === 'object' ? { ...m } : null)).filter((m) => m?.id);
  if (models && typeof models === 'object' && models.id) return [{ ...models }];
  return [];
}
function normalizePreferredModels(models) {
  if (!Array.isArray(models)) return models ? [String(models)] : [];
  return models.filter(Boolean).map(String).slice(0, 2);
}
function normalizeHubState(raw) {
  const st = { ...raw };
  st.mode = 'SELECTED';
  st.preferredProvider = st.preferredProvider && st.preferredProvider !== 'AUTO' ? String(st.preferredProvider) : '';
  st.preferredModels = normalizePreferredModels(st.preferredModels || (st.preferredModel && st.preferredModel !== 'AUTO' ? [st.preferredModel] : []));
  st.preferredModel = st.preferredModels[0] || '';
  st.connections = Array.isArray(st.connections) ? st.connections.map((c) => ({ ...c, models: normalizeModelsState(c.models) })) : [];
  return st;
}
function firstModel(conn) { return normalizeModelsState(conn.models).find((m) => m?.verified === true)?.id || normalizeModelsState(conn.models)[0]?.id || ''; }
function normalizeModels(raw, provider) {
  return (raw || []).map((m) => {
    const id = String(typeof m === 'string' ? m : (m.id || m.name || '')).replace(/^models\//, '');
    if (!id || /embedding|moderation|image-generation|tts|transcri|audio|rerank/i.test(id)) return null;
    return { id, displayName: typeof m === 'object' ? (m.displayName || id) : id, available: true, verified: false, capabilities: normalizeCaps(m, id, provider), contextWindow: typeof m === 'object' ? (m.context_length || m.inputTokenLimit || null) : null, lastVerified: null, source: 'discovery' };
  }).filter(Boolean).slice(0, 48);
}
function normalizeCaps(meta, id, provider) {
  const text = JSON.stringify(meta || '').toLowerCase(); const n = id.toLowerCase();
  return {
    chat: true, text_generation: true,
    coding: /code|gpt|claude|gemini|deepseek|grok|llama|mistral|qwen/.test(n) ? true : 'unknown',
    reasoning: /reason|think|pro|opus|sonnet|o[1-9]|grok/.test(n) ? true : 'unknown',
    vision: /vision|gpt-4o|gemini|claude|grok/.test(n) || /image/.test(text) ? true : 'unknown',
    tools: /tool|function/.test(text) ? true : 'unknown', streaming: 'unknown', function_calling: /tool|function/.test(text) ? true : 'unknown',
    long_context: Number(meta?.context_length || meta?.inputTokenLimit || 0) >= 100000 ? true : 'unknown', structured_output: provider === 'openai' || /json/.test(text) ? 'unknown' : 'unknown',
  };
}
function selectProbeModel(models) { return [...models].sort((a, b) => scoreModel(b, 'medium') - scoreModel(a, 'medium'))[0]?.id; }
function scoreModel(model, level) {
  const n = String(model.id || '').toLowerCase(); let s = 50;
  if (level === 'high' && /pro|reason|opus|sonnet|gpt-5|gpt-4|grok-4|deepseek-v4/.test(n)) s += 20;
  if (level === 'low' && /flash|mini|haiku|small|lite/.test(n)) s += 15;
  if (model.capabilities?.coding === true) s += level === 'high' ? 10 : 2;
  if (model.capabilities?.reasoning === true && level === 'high') s += 8;
  if (/preview|exp/.test(n)) s -= 5;
  return s;
}

class AnthropicAdapter {
  constructor(conn) { this.conn = conn; this.name = 'anthropic'; }
  async listModels() {
    const res = await fetch('https://api.anthropic.com/v1/models', { headers: { 'x-api-key': this.conn.apiKey, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(20000) });
    const raw = await res.text(); if (!res.ok) { const cls = classifyProviderError(raw, res.status); throw Object.assign(new Error(cls.user), { classify: cls, status: res.status }); }
    const data = JSON.parse(raw); return Array.isArray(data.data) ? data.data.map((m) => ({ id: m.id, displayName: m.display_name, contextWindow: m.max_input_tokens })) : [];
  }
  async complete({ prompt, system, json = false, model }) {
    const use = model || firstModel(this.conn); if (!use) throw new Error('Anthropic has no verified model yet.'); const started = Date.now();
    const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': this.conn.apiKey, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: use, max_tokens: 4096, system: system || undefined, messages: [{ role: 'user', content: json ? `${prompt}\nReturn JSON only.` : prompt }] }), signal: AbortSignal.timeout(120000) });
    const raw = await res.text(); if (!res.ok) { const cls = classifyProviderError(raw, res.status); throw Object.assign(new Error(cls.user), { classify: cls, status: res.status }); }
    const data = JSON.parse(raw); const text = (data.content || []).map((p) => p.text || '').join('\n'); if (!text) throw new Error('Anthropic returned an empty response');
    return { text, provider: 'anthropic', model: use, durationMs: Date.now() - started, tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0), rawMeta: { key: maskKey(this.conn.apiKey) } };
  }
}
