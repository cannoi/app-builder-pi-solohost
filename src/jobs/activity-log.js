/**
 * Append durable activity entries for a project so AI repair has full evidence history.
 * Keeps last MAX entries. Never stores secrets.
 */
const MAX = 200;

export async function appendActivity(projects, project, entry = {}) {
  if (!projects || !project) return null;
  const prev = await projects.readMetadata(project, 'activity.json', []).catch(() => []);
  const list = Array.isArray(prev) ? prev : [];
  const row = {
    t: new Date().toISOString(),
    action: String(entry.action || entry.type || 'event').slice(0, 80),
    status: String(entry.status || '').slice(0, 40),
    stage: entry.stage ? String(entry.stage).slice(0, 60) : undefined,
    detail: String(entry.detail || entry.message || entry.error || '').slice(0, 1200),
    jobId: entry.jobId || undefined,
    code: entry.code || undefined,
    files: Array.isArray(entry.files) ? entry.files.slice(0, 30) : undefined,
  };
  const next = [...list, row].slice(-MAX);
  await projects.saveMetadata(project, 'activity.json', next).catch(() => {});
  return row;
}

/** Format recent activity for AI prompts (compact evidence). */
export function formatActivityForAi(activity, limit = 40) {
  const rows = Array.isArray(activity) ? activity.slice(-limit) : [];
  if (!rows.length) return '(no activity yet)';
  return rows.map((a) => {
    const parts = [a.t || '', a.action || '', a.status || '', a.stage || '', String(a.detail || '').slice(0, 240)];
    return parts.filter(Boolean).join(' · ');
  }).join('\n');
}

/** Merge job events into activity-style lines for AI. */
export function formatJobEventsForAi(events, limit = 30) {
  const rows = Array.isArray(events) ? events.slice(-limit) : [];
  return rows.map((e) => `${e.created_at || e.t || ''} ${e.stage || ''} ${e.status || ''} ${String(e.message || '').slice(0, 200)}`).join('\n');
}
