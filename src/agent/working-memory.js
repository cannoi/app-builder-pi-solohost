/**
 * Unified Agent Working Memory (persisted per project).
 * Resume continues from this state — do not restart Upgrade from zero.
 */
const META = 'agent-working-memory.json';

export function emptyMemory(overrides = {}) {
  return {
    goal: '',
    phase: 'upgrade',
    status: 'idle',
    constraints: [],
    facts: [],
    decisions: [],
    plan: [],
    currentTask: {},
    filesInspected: [],
    filesChanged: [],
    toolCalls: [],
    tests: [],
    evidence: [],
    failures: [],
    attempts: [],
    successfulActions: [],
    failedActions: [],
    currentHypothesis: '',
    nextAction: '',
    definitionOfDone: [],
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

export async function loadWorkingMemory(projects, project) {
  const prev = await projects.readMetadata(project, META, null);
  if (!prev || typeof prev !== 'object') return emptyMemory();
  return { ...emptyMemory(), ...prev };
}

export async function saveWorkingMemory(projects, project, patch = {}) {
  const current = await loadWorkingMemory(projects, project);
  const next = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  // Cap growth of arrays
  for (const key of ['filesInspected', 'filesChanged', 'toolCalls', 'tests', 'evidence', 'failures', 'attempts', 'successfulActions', 'failedActions', 'facts', 'decisions']) {
    if (Array.isArray(next[key]) && next[key].length > 80) next[key] = next[key].slice(-80);
  }
  await projects.saveMetadata(project, META, next);
  return next;
}

export async function appendEvidence(projects, project, item) {
  const mem = await loadWorkingMemory(projects, project);
  const evidence = [...(mem.evidence || []), { at: new Date().toISOString(), ...item }];
  return saveWorkingMemory(projects, project, { evidence, status: mem.status || 'running' });
}

export async function markResumePoint(projects, project, { nextAction, currentTask, status = 'paused' } = {}) {
  return saveWorkingMemory(projects, project, {
    status,
    nextAction: nextAction || '',
    currentTask: currentTask || {},
  });
}
