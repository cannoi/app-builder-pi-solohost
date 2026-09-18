import { maskKey } from '../../utils/mask.js';

export const GEMINI_MODEL_CANDIDATES = [
  'gemini-3.1-flash-lite-preview',
  'gemini-flash-lite-latest',
  'gemini-3.5-flash-lite',
  'gemini-2.5-flash-lite',
  'gemini-flash-latest',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash',
  'gemini-3-flash-preview',
  'gemini-3.6-flash',
  'gemini-3.7-flash',
  'gemini-2.5-pro',
  'gemini-3.1-pro-preview',
  'gemini-3-pro-preview',
];

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
    if (!force) {
      const sticky = this.getStickyModel();
      if (sticky) return { model: sticky, sticky: true, candidates: [sticky] };
    }
    const models = await this.listModels();
    const usable = new Set(
      models
        .filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
        .map((m) => String(m.name || '').replace(/^models\//, '')),
    );
    const ordered = GEMINI_MODEL_CANDIDATES.filter((m) => usable.has(m));
    const fallback = [...usable].sort((a, b) => {
      const as = /flash-lite/.test(a) ? 0 : /flash/.test(a) ? 1 : 2;
      const bs = /flash-lite/.test(b) ? 0 : /flash/.test(b) ? 1 : 2;
      return as - bs || a.length - b.length;
    });
    const selected = ordered[0] || fallback[0] || null;
    if (!selected) {
      throw new Error('This Gemini key has no generateContent model. Check the key or enable the Generative Language API.');
    }
    this.setStickyModel(selected);
    return { model: selected, sticky: false, candidates: ordered, availableCount: usable.size };
  }

  async ensureModel() {
    const sticky = this.getStickyModel();
    if (sticky) {
      this.model = sticky;
      return sticky;
    }
    if (this.model) {
      this.setStickyModel(this.model);
      return this.model;
    }
    const found = await this.discover({ force: false });
    return found.model;
  }

  async complete({ prompt, system, json = false }) {
    if (!this.apiKey) throw new Error('Gemini API key is not configured');
    await this.ensureModel();
    const candidates = [this.model, ...GEMINI_MODEL_CANDIDATES].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
    let lastError = null;
    for (const model of candidates) {
      try {
        const result = await this.request(model, { prompt, system, json });
        this.setStickyModel(model);
        return result;
      } catch (err) {
        lastError = err;
        // Model not usable for this key/quota: clear sticky and try the next preferred candidate.
        if (/HTTP (400|403|404)/.test(err.message) || /not found|not supported|permission/i.test(err.message)) {
          if (this.getStickyModel() === model) this.clearStickyModel();
          continue;
        }
        throw err;
      }
    }
    throw lastError || new Error('No usable Gemini model found');
  }

  async request(model, { prompt, system, json }) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
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
      rawMeta: { key: maskKey(this.apiKey) },
    };
  }
}
