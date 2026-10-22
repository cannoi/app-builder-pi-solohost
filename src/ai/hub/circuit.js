/**
 * Per (provider, model) circuit breaker + health memory.
 */
const COOL_BASE_MS = 60_000;
const COOL_MAX_MS = 10 * 60_000;

export function modelKey(provider, model) {
  return `${provider}:${model}`;
}

export function isCooling(health = {}, now = Date.now()) {
  if (!health.coolingUntil) return false;
  return health.coolingUntil > now;
}

export function recordSuccess(health = {}, latencyMs = 0) {
  return {
    ...health,
    failStreak: 0,
    lastOkAt: new Date().toISOString(),
    avgLatencyMs: health.avgLatencyMs
      ? Math.round((health.avgLatencyMs * 0.7) + (latencyMs * 0.3))
      : latencyMs,
    coolingUntil: 0,
    state: 'healthy',
  };
}

export function recordFailure(health = {}, kind = 'error') {
  const streak = (health.failStreak || 0) + 1;
  const coolMs = Math.min(COOL_MAX_MS, COOL_BASE_MS * (2 ** Math.min(streak - 1, 4)));
  return {
    ...health,
    failStreak: streak,
    lastFailAt: new Date().toISOString(),
    lastFailKind: kind,
    coolingUntil: Date.now() + coolMs,
    state: kind === 'TIMEOUT' || kind === 'STALLED' || kind === 'OVERLOADED' ? 'cooling' : 'error',
  };
}

export function rankByHealth(entries, healthMap = {}) {
  return entries.slice().sort((a, b) => {
    const ha = healthMap[modelKey(a.conn.provider, a.model)] || {};
    const hb = healthMap[modelKey(b.conn.provider, b.model)] || {};
    const ca = isCooling(ha) ? 1 : 0;
    const cb = isCooling(hb) ? 1 : 0;
    if (ca !== cb) return ca - cb;
    const la = ha.avgLatencyMs || 99999;
    const lb = hb.avgLatencyMs || 99999;
    return la - lb;
  });
}
