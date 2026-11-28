/**
 * Unified engineering context — merges task-context + working-memory concepts
 * into engineering-context.json without breaking legacy files.
 */
const META = 'engineering-context.json';

export function emptyEngineeringContext(overrides = {}) {
  return {
    schemaVersion: 1,
    sessionId: null,
    taskType: null,
    originalRequest: '',
    acceptanceCriteria: [],
    architecture: null,
    selectedTemplate: null,
    decisions: [],
    filesInspected: [],
    filesModified: [],
    toolCalls: [],
    validation: null,
    errors: [],
    repairAttempts: [],
    remainingIssues: [],
    currentStage: 'idle',
    nextAction: '',
    status: 'idle',
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

export async function loadEngineeringContext(projects, project) {
  const prev = await projects.readMetadata(project, META, null);
  if (prev && typeof prev === 'object') return { ...emptyEngineeringContext(), ...prev };

  // Migrate from legacy files when present (shadow-friendly)
  const task = await projects.readMetadata(project, 'task-context.json', null).catch(() => null);
  const mem = await projects.readMetadata(project, 'agent-working-memory.json', null).catch(() => null);
  const base = emptyEngineeringContext();
  if (task && typeof task === 'object') {
    base.sessionId = task.sessionId || null;
    base.taskType = task.taskType || null;
    base.originalRequest = task.originalRequest || '';
    base.currentStage = task.currentStage || 'idle';
    base.filesModified = task.modifiedFiles || [];
    base.decisions = task.technicalDecisions || [];
    base.status = task.status || 'idle';
  }
  if (mem && typeof mem === 'object') {
    base.decisions = [...new Set([...(base.decisions || []), ...(mem.decisions || [])])].slice(-40);
    base.filesInspected = mem.filesInspected || [];
    base.nextAction = mem.nextAction || '';
  }
  return base;
}

export async function saveEngineeringContext(projects, project, patch = {}) {
  const current = await loadEngineeringContext(projects, project);
  const next = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  for (const key of ['decisions', 'filesInspected', 'filesModified', 'toolCalls', 'errors', 'repairAttempts', 'remainingIssues', 'acceptanceCriteria']) {
    if (Array.isArray(next[key]) && next[key].length > 80) next[key] = next[key].slice(-80);
  }
  await projects.saveMetadata(project, META, next);
  return next;
}

export async function appendToolCall(projects, project, entry) {
  const ctx = await loadEngineeringContext(projects, project);
  const toolCalls = [...(ctx.toolCalls || []), {
    at: new Date().toISOString(),
    toolId: entry.toolId,
    status: entry.status,
    durationMs: entry.durationMs,
    ok: entry.ok,
  }].slice(-80);
  return saveEngineeringContext(projects, project, { toolCalls, currentStage: entry.stage || ctx.currentStage });
}
