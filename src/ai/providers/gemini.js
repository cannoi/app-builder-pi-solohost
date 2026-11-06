import { maskKey } from '../../utils/mask.js';

export const GEMINI_MODEL_CANDIDATES = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
];

export function geminiVersion(name) {
  const n = String(name || '').toLowerCase();
  const m = n.match(/(\d+)\.(\d+)/);
  if (m) return Number(m[1]) + Number(m[2]) / 10;
  const major = n.match(/gemini-(\d+)/);
  return major ? Number(major[1]) : 0;
}

export function geminiShouldRotate(err) {
  const msg = String(err?.message || err || '');
  // Only overload/rate-limit/unavailable — never rotate on 400/auth (wrong request or key)
  return /HTTP (429|503)/.test(msg)
    || /UNAVAILABLE|high demand|overloaded|resource exhausted|try again later/i.test(msg);
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
      signal: AbortSignal.timeout(15000),
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
    // Prefer user sticky / configured model — never auto-discover over a choice.
    const sticky = this.getStickyModel();
    if (sticky) {
      this.model = sticky;
      return sticky;
    }
    if (this.model) {
      this.setStickyModel(this.model);
      return this.model;
    }
    const fallback = GEMINI_MODEL_CANDIDATES[0] || 'gemini-2.5-flash';
    this.model = fallback;
    return fallback;
  }

  async complete({ prompt, system, json = false, model = null, images = [], signal = null, timeoutMs = 0 }) {
    if (!this.apiKey) throw new Error('Gemini API key is not configured');
    // Explicit model argument wins; then sticky; never rotate.
    let useModel = model || this.getStickyModel() || this.model;
    if (!useModel) useModel = await this.ensureModel();
    if (!useModel) throw new Error('No Gemini model selected');
    const result = await this.request(useModel, { prompt, system, json, images, signal, timeoutMs });
    this.setStickyModel(useModel);
    return result;
  }

  async request(model, { prompt, system, json, images = [], signal: outerSignal = null, timeoutMs = 0 } = {}) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt }, ...images.map((i) => ({ inlineData: { mimeType: i.mimeType || i.type || 'image/png', data: String(i.dataUrl || '').replace(/^data:[^;]+;base64,/, '') } }))] }],
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      generationConfig: json
        ? { responseMimeType: 'application/json', temperature: 0.3 }
        : { temperature: 0.4 },
    };
    const started = Date.now();
    // 1.8.9: caller-provided (task-aware) timeout; 45 s remains the default for plain calls.
    const timeout = AbortSignal.timeout(timeoutMs > 0 ? timeoutMs : 45000);
    const signal = outerSignal
      ? AbortSignal.any([timeout, outerSignal])
      : timeout;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify(body),
      signal,
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${raw.slice(0, 500)}`);
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
      finishReason: data.candidates?.[0]?.finishReason || null,
      rawMeta: { key: maskKey(this.apiKey) },
    };
  }
}
