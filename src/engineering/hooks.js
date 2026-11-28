/**
 * Non-blocking shadow hooks for CREATE/IMPROVE/UPGRADE/IMPORT.
 * Never throws into the job path and never writes source: the shadow run executes inside a source
 * guard. If anything changed, the tree is restored and this hook reports a loud FAIL
 * (code SHADOW_MUTATION) instead of a silent result.
 */
export async function shadowInspect(ctx, { project, taskType = 'improve', emit } = {}) {
  const say = (status, message) => { if (emit) { try { emit({ stage: 'engineering', status, message }); } catch { /* */ } } };
  try {
    const toolkit = ctx?.engineering;
    if (!toolkit?.enabled || toolkit.mode === 'off') return null;
    const projects = ctx.projects;
    if (!project || !projects) return null;
    const sourceDir = projects.sourceDir(project.slug);
    say('running', `Engineering toolkit (${toolkit.mode}): inspecting project…`);
    const result = await toolkit.runShadow(toolkit, { sourceDir, taskType, projects, project });
    say('done', `Engineering ${toolkit.mode}: ${result.status} — ${(result.results || []).map((r) => `${r.tool}:${r.status}`).slice(0, 8).join(', ')}`);
    return result;
  } catch (err) {
    if (err?.code === 'SHADOW_MUTATION') {
      try { ctx?.log?.error?.({ changed: err.changed }, 'engineering shadow mutated source — restored'); } catch { /* */ }
      say('failed', `Engineering shadow FAILED: ${String(err.message).slice(0, 200)}`);
      return { ok: false, status: 'FAIL', code: 'SHADOW_MUTATION', changed: err.changed || [], error: err.message };
    }
    say('done', `Engineering shadow skipped: ${String(err?.message || err).slice(0, 120)}`);
    return null;
  }
}
