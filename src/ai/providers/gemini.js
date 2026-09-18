import { maskKey } from '../../utils/mask.js';

export const GEMINI_MODEL_CANDIDATES = [
  'gemini-3.1-pro-preview',
  'gemini-3-pro-preview',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite-preview',
  'gemini-3-flash-preview',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-flash-latest',
  'gemini-flash-lite-latest',
];

export function geminiVersion(name) {
  const n = String(name || '').toLowerCase();
  const m = n.match(/(\d+)\.(\d+)/);
  if (m) return Number(m[1]) + Number(m[2]) / 10;
  const major = n.match(/gemini-(\d+)/);
  return major ? Number(major[1]) : 0;
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
    // A configured model is only a preference. Verify it against the key's
    // actual model list before pinning it, otherwise an obsolete model name can
    // make every request fail even though a newer valid model is available.
    if (this.model && geminiVersion(this.model) >= 2.5) {
      try {
        const models = await this.listModels();
        const usable = new Set(models
          .filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
          .map((m) => String(m.name || '').replace(/^models\//, '')));
        if (usable.has(this.model)) {
          this.setStickyModel(this.model);
          return this.model;
        }
      } catch (err) {
        this.log?.warn?.('Gemini model verification failed; using discovery fallback', { error: err.message });
      }
    }
    const found = await this.discover({ force: true });
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
