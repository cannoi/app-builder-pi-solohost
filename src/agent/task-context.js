/**
 * Universal Persistent AI Task Context (task-scoped, provider-independent).
 * Builder owns memory across multiple bounded AI requests within ONE CREATE/BUILD/IMPROVE/UPGRADE.
 * Does NOT assume providers remember prior HTTP calls.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

const als = new AsyncLocalStorage();
const META = 'task-context.json';
const MAX_EVENTS = 80;
const MAX_DECISIONS = 40;
const MAX_FILES = 60;
const MAX_ERRORS = 30;

function now() {
  return new Date().toISOString();
}

export function emptyTaskContext(overrides = {}) {
  return {
    sessionId: randomUUID(),
    taskType: 'IMPROVE',
    originalRequest: '',
    projectId: null,
    projectSlug: null,
    provider: null,
    model: null,
    projectArchitecture: [],
    executionPlan: [],
    completedTasks: [],
    pendingTasks: [],
    technicalDecisions: [],
    modifiedFiles: [],
    protectedFiles: [],
    previousResults: [],
    detectedErrors: [],
    repairHistory: [],
    verificationResults: [],
    events: [],
    currentStage: 'init',
    status: 'active',
    createdAt: now(),
    updatedAt: now(),
    ...overrides,
  };
}

export function getActiveTaskContext() {
  return als.getStore() || null;
}

export function runWithTaskContext(ctx, fn) {
  if (!ctx) return fn();
  return als.run(ctx, fn);
}

/** Bind context for the remainder of the current async resource (CREATE/UPGRADE job handlers). */
export function enterTaskContext(ctx) {
  if (!ctx) return;
  if (typeof als.enterWith === 'function') als.enterWith(ctx);
}

export function createTaskContext({
  taskType = 'IMPROVE',
  originalRequest = '',
  projectId = null,
  projectSlug = null,
  provider = null,
  model = null,
  protectedFiles = [],
  executionPlan = [],
} = {}) {
  return emptyTaskContext({
    taskType: String(taskType || 'IMPROVE').toUpperCase(),
    originalRequest: String(originalRequest || '').slice(0, 4000),
    projectId,
    projectSlug,
    provider,
    model,
    protectedFiles: (protectedFiles || []).map(String).slice(0, MAX_FILES),
    executionPlan: (executionPlan || []).slice(0, 40),
    currentStage: 'analyze',
    status: 'active',
  });
}

function touch(ctx, patch = {}) {
  if (!ctx) return null;
  Object.assign(ctx, patch, { updatedAt: now() });
  return ctx;
}

export function appendTaskEvent(event = {}) {
  const ctx = getActiveTaskContext();
  if (!ctx) return null;
  const entry = {
    at: now(),
    type: event.type || 'note',
    stage: event.stage || ctx.currentStage,
    task: event.task || null,
    provider: event.provider || null,
    model: event.model || null,
    summary: String(event.summary || event.message || '').slice(0, 500),
    files: Array.isArray(event.files) ? event.files.map(String).slice(0, 20) : undefined,
    ok: event.ok,
  };
  ctx.events = [...(ctx.events || []), entry].slice(-MAX_EVENTS);
  if (entry.provider) ctx.provider = entry.provider;
  if (entry.model) ctx.model = entry.model;
  ctx.updatedAt = now();
  return entry;
}

export function updateTaskProgress(patch = {}) {
  const ctx = getActiveTaskContext();
  if (!ctx) return null;
  if (patch.currentStage) ctx.currentStage = patch.currentStage;
  if (patch.status) ctx.status = patch.status;
  if (Array.isArray(patch.completedTasks)) {
    ctx.completedTasks = unique([...ctx.completedTasks, ...patch.completedTasks]).slice(-40);
  }
  if (Array.isArray(patch.pendingTasks)) {
    ctx.pendingTasks = patch.pendingTasks.slice(0, 40);
  }
  if (Array.isArray(patch.technicalDecisions)) {
    ctx.technicalDecisions = [...ctx.technicalDecisions, ...patch.technicalDecisions.map((d) => String(d).slice(0, 400))].slice(-MAX_DECISIONS);
  }
  if (Array.isArray(patch.modifiedFiles)) {
    ctx.modifiedFiles = unique([...ctx.modifiedFiles, ...patch.modifiedFiles]).slice(-MAX_FILES);
  }
  if (Array.isArray(patch.detectedErrors)) {
    ctx.detectedErrors = [...ctx.detectedErrors, ...patch.detectedErrors.map((e) => String(e).slice(0, 400))].slice(-MAX_ERRORS);
  }
  if (Array.isArray(patch.verificationResults)) {
    ctx.verificationResults = [...(ctx.verificationResults || []), ...patch.verificationResults].slice(-30);
  }
  if (Array.isArray(patch.repairHistory)) {
    ctx.repairHistory = [...(ctx.repairHistory || []), ...patch.repairHistory].slice(-30);
  }
  if (Array.isArray(patch.previousResults)) {
    ctx.previousResults = [...(ctx.previousResults || []), ...patch.previousResults.map((r) => String(r).slice(0, 500))].slice(-30);
  }
  if (patch.provider) ctx.provider = patch.provider;
  if (patch.model) ctx.model = patch.model;
  ctx.updatedAt = now();
  return ctx;
}

export function compactTaskContext(ctx = getActiveTaskContext()) {
  if (!ctx) return null;
  return {
    sessionId: ctx.sessionId,
    taskType: ctx.taskType,
    originalRequest: String(ctx.originalRequest || '').slice(0, 1200),
    provider: ctx.provider,
    model: ctx.model,
    currentStage: ctx.currentStage,
    status: ctx.status,
    completedTasks: (ctx.completedTasks || []).slice(-12),
    pendingTasks: (ctx.pendingTasks || []).slice(0, 12),
    technicalDecisions: (ctx.technicalDecisions || []).slice(-12),
    modifiedFiles: (ctx.modifiedFiles || []).slice(-24),
    protectedFiles: (ctx.protectedFiles || []).slice(0, 24),
    detectedErrors: (ctx.detectedErrors || []).slice(-8),
    verificationResults: (ctx.verificationResults || []).slice(-6),
    repairHistory: (ctx.repairHistory || []).slice(-6),
    recentEvents: (ctx.events || []).slice(-10).map((e) => ({
      at: e.at,
      type: e.type,
      stage: e.stage,
      task: e.task,
      provider: e.provider,
      summary: e.summary,
      ok: e.ok,
    })),
  };
}

/** Compact text block injected into AI system/prompt for continuity */
export function buildTaskContextBlock(ctx = getActiveTaskContext()) {
  const c = compactTaskContext(ctx);
  if (!c) return '';
  const lines = [
    '### PERSISTENT TASK CONTEXT (Builder-managed; same logical session across requests)',
    `sessionId: ${c.sessionId}`,
    `taskType: ${c.taskType}`,
    `stage: ${c.currentStage} | status: ${c.status}`,
    c.provider || c.model ? `provider/model: ${c.provider || '?'} / ${c.model || '?'}` : null,
    `originalRequest: ${c.originalRequest}`,
    c.completedTasks?.length ? `completed: ${c.completedTasks.join(' | ')}` : null,
    c.pendingTasks?.length ? `pending: ${c.pendingTasks.join(' | ')}` : null,
    c.technicalDecisions?.length ? `decisions: ${c.technicalDecisions.join(' || ')}` : null,
    c.modifiedFiles?.length ? `modifiedFiles: ${c.modifiedFiles.join(', ')}` : null,
    c.protectedFiles?.length ? `protectedFiles: ${c.protectedFiles.join(', ')}` : null,
    c.detectedErrors?.length ? `errors: ${c.detectedErrors.join(' || ')}` : null,
    c.verificationResults?.length ? `verification: ${JSON.stringify(c.verificationResults).slice(0, 800)}` : null,
    c.repairHistory?.length ? `repairs: ${JSON.stringify(c.repairHistory).slice(0, 600)}` : null,
    c.recentEvents?.length ? `recentEvents: ${JSON.stringify(c.recentEvents).slice(0, 900)}` : null,
    'Rules: continue from this state; do not redo completed work; do not drop protected files; fix only proven issues.',
  ].filter(Boolean);
  return lines.join('\n');
}

export async function saveTaskCheckpoint(projects, project, ctx = getActiveTaskContext()) {
  if (!projects || !project || !ctx) return null;
  const snapshot = { ...compactTaskContext(ctx), events: (ctx.events || []).slice(-MAX_EVENTS), fullStatus: ctx.status };
  await projects.saveMetadata(project, META, snapshot);
  return snapshot;
}

export async function loadTaskCheckpoint(projects, project) {
  if (!projects || !project) return null;
  const prev = await projects.readMetadata(project, META, null);
  if (!prev || typeof prev !== 'object') return null;
  return emptyTaskContext({ ...prev, status: prev.status === 'closed' ? 'closed' : 'active' });
}

export function closeTaskContext({ status = 'completed', summary = '' } = {}) {
  const ctx = getActiveTaskContext();
  if (!ctx) return null;
  ctx.status = status;
  ctx.currentStage = 'finalize';
  if (summary) {
    ctx.previousResults = [...(ctx.previousResults || []), String(summary).slice(0, 500)].slice(-30);
  }
  appendTaskEvent({ type: 'session_close', summary: summary || status, ok: status === 'completed' });
  ctx.updatedAt = now();
  return ctx;
}

function unique(arr) {
  return [...new Set((arr || []).filter(Boolean).map(String))];
}

/** Inject compact task context into system string (idempotent-ish). */
export function applyTaskContextToSystem(system = '') {
  const block = buildTaskContextBlock();
  if (!block) return system || '';
  if (String(system).includes('PERSISTENT TASK CONTEXT')) return system;
  return `${String(system || '').trim()}\n\n${block}`.trim();
}

export default {
  createTaskContext,
  getActiveTaskContext,
  runWithTaskContext,
  enterTaskContext,
  appendTaskEvent,
  updateTaskProgress,
  compactTaskContext,
  buildTaskContextBlock,
  saveTaskCheckpoint,
  loadTaskCheckpoint,
  closeTaskContext,
  applyTaskContextToSystem,
  emptyTaskContext,
};
