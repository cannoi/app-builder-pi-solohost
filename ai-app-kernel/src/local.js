function defaultCandidates(provider, extraBase) {
  const explicit = process.env.OLLAMA_BASE_URL;
  // OLLAMA_HOST is host:port for the server bind — not always a URL
  let hostEnv = process.env.OLLAMA_HOST || '';
  if (hostEnv && !/^https?:/i.test(hostEnv)) hostEnv = `http://${hostEnv}`;
  const service = process.env.OLLAMA_SERVICE ? `http://${process.env.OLLAMA_SERVICE}:11434` : null;
  const configured = extraBase || provider?.baseUrl;
  // Same-container managed Ollama first, then sidecar DNS, then host fallbacks
  const urls = [
    explicit,
    hostEnv,
    'http://127.0.0.1:11434',
    'http://localhost:11434',
    service,
    configured,
    'http://ollama:11434',
    'http://personal-ai-ollama:11434',
    'http://host.docker.internal:11434',
    'http://host.containers.internal:11434',
    'http://172.17.0.1:11434'
  ]
    .filter(Boolean)
    .map(x => String(x).replace(/\/$/, ''));
  return [...new Set(urls)];
}

/** Curated light models for SoloHost — never auto-download. */
export const SUGGESTED_LOCAL_MODELS = [
  { id: 'qwen3:4b', name: 'Qwen3 4B', sizeHint: '~2.5 GB', minRamGb: 6, recommended: true },
  { id: 'llama3.2:3b', name: 'Llama 3.2 3B', sizeHint: '~2 GB', minRamGb: 4, recommended: true },
  { id: 'gemma3:4b', name: 'Gemma 3 4B', sizeHint: '~3 GB', minRamGb: 6, recommended: false },
  { id: 'phi3:mini', name: 'Phi-3 Mini', sizeHint: '~2.3 GB', minRamGb: 4, recommended: false },
  { id: 'llama3.2:1b', name: 'Llama 3.2 1B', sizeHint: '~1.3 GB', minRamGb: 2, recommended: true }
];

export function createLocalModelManager(provider, fetchImpl = fetch) {
  let lastGood = null;
  let customBase = null;
  let negCache = { until: 0, error: null, candidates: [] };
  let posCache = { until: 0, data: null };
  let startingUntil = 0; // grace period after first miss (Ollama may still be booting)

  function candidates() {
    return defaultCandidates(provider, customBase);
  }

  async function request(path, init = {}) {
    const urls = [lastGood, customBase, ...candidates()].filter(Boolean);
    let lastError = null;
    const timeoutMs = Number(init.timeoutMs || 8000);
    for (const base of [...new Set(urls)]) {
      try {
        const r = await fetchImpl(`${base}${path}`, { ...init, timeoutMs });
        if (!r.ok) {
          let body = '';
          try { body = await r.text(); } catch {}
          throw new Error(`LOCAL_${r.status}${body ? ': ' + body.slice(0, 160) : ''}`);
        }
        lastGood = base;
        negCache = { until: 0, error: null, candidates: [] };
        startingUntil = 0;
        return r;
      } catch (err) {
        lastError = err;
      }
    }
    const tried = [...new Set(urls)].join(', ');
    const e = lastError || new Error('OLLAMA_UNREACHABLE');
    e.code = 'OLLAMA_UNREACHABLE';
    e.message = `${String(e.message || 'OLLAMA_UNREACHABLE')} (tried: ${tried})`;
    throw e;
  }

  async function json(path, init) {
    const r = await request(path, init);
    return r.json();
  }

  return {
    setBaseUrl(url) {
      customBase = url ? String(url).replace(/\/$/, '') : null;
      lastGood = customBase;
      negCache = { until: 0, error: null, candidates: [] };
      posCache = { until: 0, data: null };
      if (customBase && provider) provider.baseUrl = customBase;
    },
    getBaseUrl() {
      return customBase || lastGood || null;
    },
    async models(opts = {}) {
      const force = !!opts.force;
      const now = Date.now();
      if (!force && posCache.data && posCache.until > now) return { ...posCache.data, cached: true };
      if (!force && negCache.until > now) {
        const starting = startingUntil > now;
        return {
          available: false,
          models: [],
          error: negCache.error,
          code: starting ? 'OLLAMA_STARTING' : 'OLLAMA_UNREACHABLE',
          status: starting ? 'starting' : 'unavailable',
          candidates: negCache.candidates,
          cached: true,
          retryAfterMs: Math.max(0, negCache.until - now),
          suggested: SUGGESTED_LOCAL_MODELS
        };
      }
      try {
        const data = await json('/api/tags', { timeoutMs: 6000 });
        const models = (data.models || []).map(m => (typeof m === 'string' ? m : m.name)).filter(Boolean);
        const result = {
          available: true,
          models,
          baseUrl: lastGood || customBase || null,
          candidates: candidates(),
          code: models.length ? 'OK' : 'NO_LOCAL_MODELS',
          status: models.length ? 'ready' : 'ready_no_models',
          suggested: SUGGESTED_LOCAL_MODELS
        };
        posCache = { until: now + 60_000, data: result };
        return result;
      } catch (err) {
        const error = String(err?.message || err);
        // First failures: treat as "starting" for 90s (compose depends_on doesn't wait for Ollama listen)
        if (!startingUntil) startingUntil = now + 180_000;
        const starting = startingUntil > now;
        const backoff = starting ? 60_000 : Math.min(15 * 60_000, 300_000); // 1 min starting / 5–15 min offline
        negCache = { until: now + backoff, error, candidates: candidates() };
        posCache = { until: 0, data: null };
        return {
          available: false,
          models: [],
          error,
          code: starting ? 'OLLAMA_STARTING' : 'OLLAMA_UNREACHABLE',
          status: starting ? 'starting' : 'unavailable',
          candidates: candidates(),
          cached: false,
          retryAfterMs: backoff,
          suggested: SUGGESTED_LOCAL_MODELS,
          hint: starting
            ? 'Managed Ollama is still starting inside the Hub container. Wait 1–2 minutes then Refresh.'
            : 'Cannot reach managed Ollama at http://127.0.0.1:11434 inside the Hub container. Rebuild/redeploy so docker-entrypoint or start-ollama.js can run `ollama serve`. Cloud providers keep working.'
        };
      }
    },
    async pull(name) {
      const model = String(name || '').trim();
      if (!model) {
        const e = new Error('MODEL_NAME_REQUIRED');
        e.code = 'MODEL_NAME_REQUIRED';
        throw e;
      }
      const health = await this.models({ force: true });
      if (!health.available) {
        const e = new Error(health.hint || health.error || 'OLLAMA_UNREACHABLE');
        e.code = health.code || 'OLLAMA_UNREACHABLE';
        e.statusCode = 503;
        throw e;
      }
      if ((health.models || []).includes(model) || (health.models || []).some(m => m === model || m.startsWith(model + ':'))) {
        return { status: 'already_present', model };
      }
      try {
        const result = await json('/api/pull', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: model, stream: false }),
          timeoutMs: 600000
        });
        posCache = { until: 0, data: null };
        return result;
      } catch (err) {
        const e = new Error(String(err?.message || err));
        e.code = 'MODEL_DOWNLOAD_FAILED';
        e.statusCode = 502;
        throw e;
      }
    },
    async show(name) {
      return json('/api/show', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
        timeoutMs: 30000
      });
    },
    async health(opts = {}) {
      return this.models(opts);
    },
    baseUrl() {
      return lastGood || customBase || candidates()[0] || null;
    },
    candidateUrls: () => candidates(),
    suggestedModels: () => SUGGESTED_LOCAL_MODELS
  };
}
