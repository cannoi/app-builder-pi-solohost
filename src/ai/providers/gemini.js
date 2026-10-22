import { classifyProviderError } from '../hub/errors.js';
import { maskKey } from '../../utils/mask.js';

export const GEMINI_MODEL_CANDIDATES = ['gemini-2.5-flash-lite', 'gemini-flash-latest']; // offline unverified only — never retired 1.5/2.0

export function geminiVersion(name) {
  const n = String(name || '').toLowerCase();
  const m = n.match(/(\d+)\.(\d+)/);
  if (m) return Number(m[1]) + Number(m[2]) / 10;
  const major = n.match(/gemini-(\d+)/);
  return major ? Number(major[1]) : 0;
}

export function geminiShouldRotate(err) {
  const msg = String(err?.message || err || '');
  return /HTTP (400|403|404|429|503)/.test(msg)
    || /UNAVAILABLE|high demand|overloaded|resource exhausted|not found|not supported|permission|try again later/i.test(msg);
}

export function compareGeminiModels(a, b) {
  const va = geminiVersion(a);
  const vb = geminiVersion(b);
  if (vb !== va) return vb - va;
  const rank = (n) => (/pro/.test(n) ? 3 : /flash/.test(n) && !/lite/.test(n) ? 2 : 1);
  return rank(String(b)) - rank(String(a));
}

export class GeminiProvider {
  constructor({ apiKey, model, db = null, log = null }) {
    this.name = 'gemini';
    this.apiKey = apiKey;
    this.model = model || '';
    this.db = db;
    this.log = log;
  }

  configured() { return Boolean(this.apiKey); }

  getStickyModel() {
    return this.db?.setting('geminiStickyModel', '') || '';
  }

  setStickyModel(model) {
    if (model) this.db?.setSetting('geminiStickyModel', model);
    this.model = model || this.model;
  }

  clearStickyModel() {
    this.db?.setSetting('geminiStickyModel', '');
  }

  async listModels() {
    if (!this.apiKey) throw new Error('Gemini API key is not configured');
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
      headers: { 'x-goog-api-key': this.apiKey },
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`Gemini model discovery HTTP ${res.status}`);
    const data = JSON.parse(raw);
    return Array.isArray(data.models) ? data.models : [];
  }

  async discover({ force = false } = {}) {
    if (!this.apiKey) throw new Error('Gemini API key is not configured');
    const sticky = this.getStickyModel();
    if (!force && sticky && geminiVersion(sticky) >= 2.5) {
      return { model: sticky, sticky: true, candidates: [sticky] };
    }
    const models = await this.listModels();
    const usable = new Set(
      models
        .filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
        .map((m) => String(m.name || '').replace(/^models\//, '')),
    );
    const preferred = [...usable]
      .filter((m) => geminiVersion(m) >= 2.5)
      .sort(compareGeminiModels);
    const ordered = preferred.filter((v, i, a) => a.indexOf(v) === i);
    const fallback = [...usable].sort(compareGeminiModels);
    const selected = ordered[0] || fallback[0] || null;
    if (!selected) {
      throw new Error('This Gemini key has no generateContent model. Check the key or enable the Generative Language API.');
    }
    this.setStickyModel(selected);
    return { model: selected, sticky: false, candidates: ordered, availableCount: usable.size };
  }

  async ensureModel() {
    const sticky = this.getStickyModel();
    if (sticky && geminiVersion(sticky) >= 2.5) {
      this.model = sticky;
      return sticky;
    }
    // A configured model is a usable preference. Do not make every generation
    // depend on a separate model-list request: that endpoint can be blocked or
    // rate-limited even when generateContent itself works. Request-time model
    // rotation below remains the fallback for stale model names.
    if (this.model && geminiVersion(this.model) >= 2.5) {
      this.setStickyModel(this.model);
      return this.model;
    }
    try {
      const found = await this.discover({ force: true });
      return found.model;
    } catch (err) {
      const fallback = 'gemini-3.8-flash';
      this.model = fallback;
      this.log?.warn?.('Gemini model discovery unavailable; using stable fallback candidate', { error: err.message, model: fallback });
      return fallback;
    }
  }

  async complete({ prompt, system, json = false, model = null, images = [], signal = null }) {
    if (!this.apiKey) throw new Error('Gemini API key is not configured');
    // Hub owns multi-model rotation (max 3 attempts). Provider tries only the requested model.
    const requested = model || this.model || GEMINI_MODEL_CANDIDATES[0];
    if (!requested) throw new Error('No Gemini model selected');
    const result = await this.request(requested, { prompt, system, json, images, signal });
    this.setStickyModel(requested);
    return result;
  }

  async request(model, { prompt, system, json, images = [], signal = null }) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt }, ...images.map((i) => ({ inlineData: { mimeType: i.mimeType || i.type || 'image/png', data: String(i.dataUrl || '').replace(/^data:[^;]+;base64,/, '') } }))] }],
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      generationConfig: json
        ? { responseMimeType: 'application/json', temperature: 0.3 }
        : { temperature: 0.4 },
    };
    const started = Date.now();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify(body),
      signal: signal || AbortSignal.timeout(45000),
    });
    const raw = await res.text();
    if (!res.ok) {
      const err = new Error(`Gemini HTTP ${res.status}: ${raw.slice(0, 500)}`);
      err.status = res.status;
      err.classify = classifyProviderError(err, res.status);
      throw err;
    }
    let data;
    try { data = JSON.parse(raw); } catch { throw new Error('Gemini returned invalid JSON'); }
    const text = (data.candidates || []).flatMap((c) => c.content?.parts || []).map((p) => p.text || '').join('');
    if (!text) throw new Error('Gemini returned an empty response');
    return {
      text,
      provider: this.name,
      model,
      durationMs: Date.now() - started,
      tokens: data.usageMetadata?.totalTokenCount ?? null,
      rawMeta: { key: maskKey(this.apiKey) },
    };
  }
}
