import { normalizeArray } from '../utils/validate.js';
import { uuid } from '../utils/ids.js';

const FILE = 'upgrade-session.json';

function now() { return new Date().toISOString(); }

export async function readUpgradeSession(projects, project) {
  return projects.readMetadata(project, FILE, null);
}

export async function createUpgradeSession(projects, project, {
  sourceCommit = '', request = '', baselineHash = '', steps = [], mode = 'normal', ruleName = '',
} = {}) {
  const stamp = now();
  const session = {
    id: uuid(),
    mode,
    ruleName: ruleName || null,
    sourceCommit: String(sourceCommit || ''),
    baselineHash: String(baselineHash || ''),
    request: String(request || '').slice(0, 8000),
    status: 'running',
    resumable: true,
    phase: 'plan',
    currentStep: steps[0]?.id || null,
    steps: (steps || []).map((step, index) => ({
      id: String(step.id || `step-${index + 1}`),
      label: String(step.label || step.goal || step.action || `Step ${index + 1}`).slice(0, 500),
      status: index === 0 ? 'running' : 'pending',
      startedAt: index === 0 ? stamp : null,
      finishedAt: null,
      result: null,
      error: null,
    })),
    completedSteps: [],
    changedFiles: [],
    checkpoints: [],
    verification: [],
    planHash: null,
    workingHash: null,
    finalHash: null,
    provider: null,
    lastError: null,
    createdAt: stamp,
    updatedAt: stamp,
    finishedAt: null,
  };
  await projects.saveMetadata(project, FILE, session);
  return session;
}

export async function updateUpgradeSession(projects, project, patch = {}) {
  const current = await readUpgradeSession(projects, project) || {};
  const stamp = now();
  const next = {
    ...current,
    ...patch,
    updatedAt: stamp,
    changedFiles: unique([...normalizeArray(current.changedFiles), ...normalizeArray(patch.changedFiles)]),
    checkpoints: unique([...normalizeArray(current.checkpoints), ...normalizeArray(patch.checkpoints)]),
    completedSteps: unique([...normalizeArray(current.completedSteps), ...normalizeArray(patch.completedSteps)]),
    verification: [...normalizeArray(current.verification), ...normalizeArray(patch.verification)].slice(-30),
  };
  if (patch.stepId) {
    next.steps = (current.steps || []).map((step) => step.id === patch.stepId
      ? { ...step, ...(patch.step || {}), updatedAt: stamp }
      : step);
    delete next.stepId;
    delete next.step;
  }
  await projects.saveMetadata(project, FILE, next);
  return next;
}

export async function pauseUpgradeSession(projects, project, error = {}) {
  return updateUpgradeSession(projects, project, {
    status: 'paused',
    resumable: true,
    lastError: {
      code: String(error.code || 'UPGRADE_PAUSED'),
      message: String(error.message || error || 'Upgrade paused').slice(0, 1200),
      at: now(),
    },
  });
}

export async function resumeUpgradeSession(projects, project) {
  const current = await readUpgradeSession(projects, project);
  if (!current) throw new Error('No resumable Upgrade session was found.');
  if (!current.resumable || ['completed', 'completed_no_change', 'rolled_back'].includes(current.status)) throw new Error('This Upgrade session cannot be resumed.');
  return updateUpgradeSession(projects, project, { status: 'running', lastError: null });
}

export async function completeUpgradeSession(projects, project, patch = {}) {
  const status = patch.status === 'completed_no_change' ? 'completed_no_change' : 'completed';
  return updateUpgradeSession(projects, project, {
    ...patch,
    status,
    resumable: false,
    phase: 'complete',
    finishedAt: now(),
  });
}

export async function failUpgradeSession(projects, project, error, { resumable = true } = {}) {
  return updateUpgradeSession(projects, project, {
    status: resumable ? 'paused' : 'failed',
    resumable,
    lastError: { code: String(error?.code || 'UPGRADE_FAILED'), message: String(error?.message || error).slice(0, 1200), at: now() },
  });
}

function unique(values) { return [...new Set((values || []).filter(Boolean).map(String))]; }
