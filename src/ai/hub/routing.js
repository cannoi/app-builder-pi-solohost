/**
 * Single source of truth for AI routing: AUTO | SELECTED, Gemini-first defaults.
 */
export const ROUTING_MODE = Object.freeze({ AUTO: 'AUTO', SELECTED: 'SELECTED' });

/** Default connection priority when mode is AUTO (never "most recently added"). */
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

/**
 * Build ordered attempt plan: max 3 distinct (provider, model) pairs.
 * User-selected models first; then AUTO order by DEFAULT_PROVIDER_PRIORITY.
 */
export function buildAttemptPlan({
  connections = [],
  preferredModels = [],
  preferredProvider = '',
  mode = ROUTING_MODE.AUTO,
  task = '',
  maxAttempts = 3,
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

  // 1) Explicit user selections
  for (const ref of selected) {
    const [prov, ...rest] = ref.split(':');
    const modelId = rest.join(':') || prov;
    const conn =
      connections.find((c) => c.provider === prov && hasKey(c)) ||
      connections.find((c) => c.id === prov && hasKey(c)) ||
      connections.find((c) => hasKey(c) && modelList(c).some((m) => m.id === modelId));
    if (conn) push(conn, modelId.includes(':') ? rest.join(':') || modelId : modelId, 'user-selected');
  }

  if (locked && out.length) return out.slice(0, maxAttempts);

  // 2) AUTO plan: Gemini first, never by add-order
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
    const models = modelList(conn);
    const auto = models.find((m) => String(m.id).toLowerCase() === 'auto');
    const verified = models.filter((m) => m.verified);
    const pick = auto || verified[0] || models[0];
    if (pick?.id) push(conn, pick.id, auto ? 'auto' : verified[0] ? 'verified' : 'fallback');
  }

  return out.slice(0, maxAttempts);
}

function hasKey(c) {
  return Boolean(c?.apiKey || c?.keyRef || c?.hasKey);
}

function modelList(conn) {
  const m = conn?.models;
  if (!Array.isArray(m)) return [];
  return m.map((x) => (typeof x === 'string' ? { id: x } : x)).filter((x) => x?.id);
}

export function isRoutingLocked(state) {
  return normalizeRoutingMode(state?.mode) === ROUTING_MODE.SELECTED && (state?.preferredModels || []).length > 0;
}
