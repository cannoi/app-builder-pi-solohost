/**
 * Model discovery, ranking, verification states.
 * Failed probes never mark verified:true.
 */
const CACHE_MS = 6 * 60 * 60 * 1000;

const NON_CHAT = /embedding|embed|imagen|veo|aqa|tts|audio|live|bidi|image-generation|video|whisper|moderation|rerank|code-gecko/i;

export function isChatCapable(model, provider = '') {
  const id = String(model?.id || model || '');
  if (!id) return false;
  if (NON_CHAT.test(id)) return false;
  const methods = model?.supportedGenerationMethods || model?.capabilities?.methods || [];
  if (Array.isArray(methods) && methods.length) {
    return methods.some((m) => /generateContent|chat|completions|generate/i.test(String(m)));
  }
  // OpenAI-compat / unknown: allow unless non-chat pattern
  return true;
}

export function compareGeminiModels(a, b) {
  const score = (id) => {
    const s = String(id || '');
    let n = 0;
    const ver = s.match(/gemini-(\d+(?:\.\d+)?)/i);
    if (ver) n += parseFloat(ver[1]) * 1000;
    if (/-flash/i.test(s)) n += 50;
    if (/-pro/i.test(s)) n += 30;
    if (/-lite/i.test(s)) n -= 10;
    if (/-preview|-exp|-experimental/i.test(s)) n -= 5;
    if (/1\.5|2\.0|2\.5-flash$/i.test(s) && !/3\./.test(s)) n -= 20; // prefer newer families
    return n;
  };
  return score(b) - score(a);
}

export function rankModels(provider, models = []) {
  const list = (models || []).filter((m) => isChatCapable(m, provider));
  const p = String(provider || '').toLowerCase();
  if (p === 'gemini') {
    return list.slice().sort((a, b) => compareGeminiModels(a.id || a, b.id || b));
  }
  // generic: prefer auto, then verified, then alpha
  return list.slice().sort((a, b) => {
    const aid = String(a.id || a);
    const bid = String(b.id || b);
    if (aid === 'auto') return -1;
    if (bid === 'auto') return 1;
    if (a.verified && !b.verified) return -1;
    if (!a.verified && b.verified) return 1;
    return aid.localeCompare(bid);
  });
}

export function normalizeModelEntry(m, provider) {
  const id = typeof m === 'string' ? m : m?.id;
  if (!id) return null;
  return {
    id,
    displayName: m.displayName || id,
    available: m.available !== false && m.state !== 'unavailable',
    verified: m.verified === true && m.state !== 'unavailable',
    state: m.state || (m.verified ? 'verified' : 'unknown'),
    lastError: m.lastError || null,
    lastChecked: m.lastChecked || m.lastVerified || null,
    capabilities: m.capabilities || {},
    supportedGenerationMethods: m.supportedGenerationMethods,
    source: m.source || 'list',
  };
}

export function filterAndRankListed(provider, rawModels = []) {
  const normalized = rawModels.map((m) => normalizeModelEntry(m, provider)).filter(Boolean);
  const chat = normalized.filter((m) => isChatCapable(m, provider));
  return rankModels(provider, chat);
}

/** Offline fallback — never use retired 1.5/2.0 names as primary routing. */
export const OFFLINE_GEMINI_FALLBACK = ['gemini-2.5-flash-lite', 'gemini-flash-latest'];
