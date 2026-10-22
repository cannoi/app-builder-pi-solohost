/**
 * AI routing: AUTO | SELECTED, Gemini-first, multi-model ladder per provider.
 */
export const ROUTING_MODE = Object.freeze({ AUTO: 'AUTO', SELECTED: 'SELECTED' });

export const DEFAULT_PROVIDER_PRIORITY = [
  'gemini',
  'custom',
  'openai',
  'openrouter',
  'groq',
  'mistral',
  'xai',
  'anthropic',
  'deepseek',
];

export function normalizeRoutingMode(mode) {
  const m = String(mode || '').toUpperCase();
  return m === 'SELECTED' ? ROUTING_MODE.SELECTED : ROUTING_MODE.AUTO;
}

export function providerPriorityIndex(provider) {
  const i = DEFAULT_PROVIDER_PRIORITY.indexOf(String(provider || '').toLowerCase());
  return i >= 0 ? i : DEFAULT_PROVIDER_PRIORITY.length + 1;
}

function modelList(conn) {
  const m = conn?.models;
  if (!Array.isArray(m)) return [];
  return m
    .map((x) => (typeof x === 'string' ? { id: x, state: 'unknown' } : { ...x }))
    .filter((x) => x?.id && x.state !== 'unavailable');
}

function hasKey(c) {
  return Boolean(c?.apiKey || c?.keyRef || c?.hasKey || c?.credentialRef);
}

/**
 * Ladder of up to maxAttempts distinct (provider, model) pairs.
 * User selection first; then per-provider ranked models (≤2 each before next provider).
 */
export function buildAttemptPlan({
  connections = [],
  preferredModels = [],
  preferredProvider = '',
  mode = ROUTING_MODE.AUTO,
  task = '',
  maxAttempts = 4,
} = {}) {
  const selected = (preferredModels || []).map(String).filter(Boolean);
  const locked = normalizeRoutingMode(mode) === ROUTING_MODE.SELECTED && selected.length > 0;
  const out = [];
  const seen = new Set();

  const push = (conn, modelId, reason) => {
    if (!conn || !modelId || out.length >= maxAttempts) return;
    const key = `${conn.provider}:${modelId}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ conn, model: modelId, ref: key, reason });
  };

  for (const ref of selected) {
    const [prov, ...rest] = ref.split(':');
    const modelId = rest.length ? rest.join(':') : prov;
    const conn =
      connections.find((c) => c.provider === prov && hasKey(c)) ||
      connections.find((c) => c.id === prov && hasKey(c)) ||
      connections.find((c) => hasKey(c) && modelList(c).some((m) => m.id === modelId));
    if (conn) push(conn, modelId, 'user-selected');
  }

  // Even when locked, still add Auto ladder after user selection so 404 can fall through
  const list = connections
    .filter((c) => hasKey(c) && c.status !== 'INVALID')
    .slice()
    .sort((a, b) => providerPriorityIndex(a.provider) - providerPriorityIndex(b.provider));

  if (preferredProvider && preferredProvider !== 'AUTO') {
    const prefer = list.filter((c) => c.provider === preferredProvider);
    const rest = list.filter((c) => c.provider !== preferredProvider);
    list.length = 0;
    list.push(...prefer, ...rest);
  }

  for (const conn of list) {
    let models = modelList(conn);
    // rank: verified first, then by id heuristically
    models = models.slice().sort((a, b) => {
      if (a.verified && !b.verified) return -1;
      if (!a.verified && b.verified) return 1;
      if (String(a.id).toLowerCase() === 'auto') return -1;
      if (String(b.id).toLowerCase() === 'auto') return 1;
      // newer gemini first
      const ga = String(a.id).match(/gemini-(\d+(?:\.\d+)?)/);
      const gb = String(b.id).match(/gemini-(\d+(?:\.\d+)?)/);
      if (ga && gb) return parseFloat(gb[1]) - parseFloat(ga[1]);
      return String(a.id).localeCompare(String(b.id));
    });
    let added = 0;
    for (const m of models) {
      if (added >= 2) break;
      push(conn, m.id, m.verified ? 'verified' : 'ladder');
      added += 1;
    }
  }

  return out.slice(0, maxAttempts);
}

export function isRoutingLocked(state) {
  return normalizeRoutingMode(state?.mode) === ROUTING_MODE.SELECTED && (state?.preferredModels || []).length > 0;
}
