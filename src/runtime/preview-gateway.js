/**
 * Preview Gateway — fixed SoloHost-facing entry for concurrent previews.
 *
 * Design:
 *  - SoloHost only needs one stable port (the Builder HTTP port).
 *  - Each running preview is registered under /preview/<slug>/…
 *  - Internal host ports are allocated dynamically and never exposed
 *    as extra SoloHost port mappings.
 *  - Sessions are isolated; cleanup releases ports automatically.
 *
 * This module is the session registry. The actual HTTP reverse-proxy
 * logic already lives in src/preview.js and is extended to consult
 * this registry.
 */

const sessions = new Map(); // slug → { upstream, engine, startedAt, meta }

export function registerPreviewSession(slug, info) {
  const key = String(slug || '').toLowerCase();
  if (!key) return false;
  sessions.set(key, {
    upstream: info.upstream || info.url || null, // e.g. http://127.0.0.1:54321
    hostPort: info.hostPort || null,
    engine: info.engine || 'unknown',
    containerId: info.containerId || null,
    runtime_id: info.runtime_id || null,
    startedAt: Date.now(),
    meta: info.meta || {},
  });
  return true;
}

export function unregisterPreviewSession(slug) {
  return sessions.delete(String(slug || '').toLowerCase());
}

export function getPreviewSession(slug) {
  return sessions.get(String(slug || '').toLowerCase()) || null;
}

export function listPreviewSessions() {
  return [...sessions.entries()].map(([slug, s]) => ({
    slug,
    engine: s.engine,
    hostPort: s.hostPort,
    upstream: s.upstream,
    startedAt: s.startedAt,
    ageMs: Date.now() - s.startedAt,
  }));
}

export function clearAllPreviewSessions() {
  const n = sessions.size;
  sessions.clear();
  return n;
}

/**
 * Resolve the upstream base URL for a project slug.
 * Used by the existing preview HTTP handler.
 */
export function resolveUpstream(slug) {
  const s = getPreviewSession(slug);
  if (s?.upstream) return s.upstream;
  if (s?.hostPort) return `http://127.0.0.1:${s.hostPort}`;
  return null;
}

export default {
  registerPreviewSession,
  unregisterPreviewSession,
  getPreviewSession,
  listPreviewSessions,
  clearAllPreviewSessions,
  resolveUpstream,
};
