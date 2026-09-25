import { diagnoseProject, buildAdvisorReport } from './project.js';

export async function refreshProjectBrain({ project, projects, db = null, extra = {} } = {}) {
  const sourceDir = projects.sourceDir(project.slug);
  const runtime = await projects.readMetadata(project, 'runtime.json', {});
  const pending = await projects.readMetadata(project, 'release-pending.json', null);
  const diagnosis = await projects.readMetadata(project, 'project-diagnosis.json', null);
  const repairs = await projects.readMetadata(project, 'upgrade-repair-history.json', []);
  const failed = (Array.isArray(repairs) ? repairs : []).filter((r) => /fail|not_fixed|rolled/i.test(String(r.result || r.status || '')));
  const github = pending?.githubUrl ? 'connected' : 'unknown';
  const ghcr = pending?.status === 'waiting_image' ? 'building' : pending?.status === 'workflow_failed' ? 'failed' : pending?.image ? 'ready' : 'unknown';
  const health = {
    preview: runtime.status === 'passed' && runtime.health === true ? 'pass' : runtime.status ? 'fail' : 'unknown',
    github,
    ghcr,
    solohost: pending?.installReady ? 'ready' : 'unknown',
  };
  const score = ['preview', 'github', 'ghcr'].reduce((n, k) => n + (health[k] === 'pass' || health[k] === 'ready' || health[k] === 'connected' ? 30 : health[k] === 'unknown' ? 10 : 0), 10);
  const brain = {
    projectId: project.id,
    slug: project.slug,
    updatedAt: new Date().toISOString(),
    currentState: {
      preview: runtime.status || 'unknown',
      github: pending?.githubUrl || null,
      ghcr: pending?.status || null,
      image: pending?.image || null,
    },
    health,
    score: Math.min(100, score),
    lastDiagnosis: diagnosis ? { rootCause: diagnosis.rootCause, confidence: diagnosis.confidence, fingerprint: diagnosis.fingerprint } : null,
    failedRepairs: failed.slice(-12),
    notes: extra.notes || null,
    sourceDirHint: sourceDir,
  };
  await projects.saveMetadata(project, 'project-brain.json', brain);
  return brain;
}

export async function rememberFailedRepair(projects, project, record) {
  const old = await projects.readMetadata(project, 'failed-repairs.json', []);
  const rows = Array.isArray(old) ? old : [];
  rows.push({ ...record, at: new Date().toISOString() });
  await projects.saveMetadata(project, 'failed-repairs.json', rows.slice(-40));
}

export async function wasRepairTried(projects, project, fingerprint) {
  const rows = await projects.readMetadata(project, 'failed-repairs.json', []);
  return (Array.isArray(rows) ? rows : []).some((r) => r.fingerprint === fingerprint);
}

export { diagnoseProject, buildAdvisorReport };
