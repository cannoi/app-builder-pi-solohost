import { fingerprintError } from '../dare/fingerprint.js';
import crypto from 'node:crypto';
import { redactAiContext } from '../utils/mask.js';

export const REPAIR_TERMINAL_STATES = Object.freeze([
  'DONE', 'FAILED', 'NEEDS_USER_ACTION', 'NO_CHANGE', 'BLOCKED', 'ROLLED_BACK',
]);

export function shouldBlockRepeatedAction(history, fingerprint, now = Date.now(), windowMs = 10 * 60_000, maxAttempts = 2, context = {}) {
  if (!history || history.fingerprint !== fingerprint) return false;
  const sameWorkspace = context.workspaceHash && history.workspaceHash === context.workspaceHash;
  const sameValidation = context.validationHash && history.validationHash === context.validationHash;
  if (sameWorkspace && sameValidation) return true;
  const last = Date.parse(history.lastAt || '');
  if (!Number.isFinite(last) || now - last > windowMs) return false;
  return Number(history.attempts || 0) >= maxAttempts;
}

export function nextRepeatState(history, fingerprint, now = Date.now(), context = {}) {
  const same = history?.fingerprint === fingerprint && Number.isFinite(Date.parse(history?.lastAt || ''))
    ? Number.isFinite(now - Date.parse(history.lastAt))
    : false;
  return {
    fingerprint,
    attempts: same ? Number(history.attempts || 0) + 1 : 1,
    lastAt: new Date(now).toISOString(),
    workspaceHash: context.workspaceHash || null,
    validationHash: context.validationHash || null,
  };
}

export function repairFingerprint({ feedback = '', runtime = {} } = {}) {
  const evidence = [runtime?.error, runtime?.logs, runtime?.validationError, runtime?.buildError, runtime?.httpError].filter(Boolean).join('\n');
  const fp = fingerprintError(evidence);
  if (fp && fp !== 'NONE') return fp;
  return 'NO_FAILURE_EVIDENCE';
}

export function createRepairOperation({ jobId = null, projectId = null, kind = 'repair', request = '' } = {}) {
  const at = new Date().toISOString();
  return {
    operation_id: crypto.randomUUID(),
    job_id: jobId,
    project_id: projectId,
    kind,
    request: String(request || '').slice(0, 1200),
    cycle: 0,
    fingerprint_history: [],
    ai_proposal: null,
    proposed_files: [],
    actual_changed_files: [],
    transitions: [{ state: 'PREFLIGHT', at }],
    terminal_state: null,
    started_at: at,
  };
}

export function transitionRepairOperation(operation, state, evidence = {}) {
  if (!operation || operation.terminal_state) return operation;
  operation.transitions.push({
    state: String(state),
    at: new Date().toISOString(),
    ...(evidence && Object.keys(evidence).length ? { evidence: sanitize(evidence) } : {}),
  });
  return operation;
}

export function finishRepairOperation(operation, terminalState, result = {}) {
  if (!REPAIR_TERMINAL_STATES.includes(terminalState)) throw new Error(`Invalid repair terminal state: ${terminalState}`);
  if (operation && !operation.terminal_state) {
    operation.terminal_state = terminalState;
    operation.result = sanitize(result);
    operation.finished_at = new Date().toISOString();
    operation.transitions.push({
      state: terminalState,
      at: operation.finished_at,
      ...(result && Object.keys(result).length ? { evidence: sanitize(result) } : {}),
    });
  }
  return operation;
}

export async function persistRepairOperation(projects, project, operation) {
  if (!operation) return null;
  const history = await projects.readMetadata(project, 'repair-operations.json', []);
  const rows = Array.isArray(history) ? history.filter((row) => row.operation_id !== operation.operation_id) : [];
  rows.push(operation);
  await projects.saveMetadata(project, 'repair-operations.json', rows.slice(-40));
  return operation;
}

function sanitize(value) {
  if (typeof value === 'string') return redactAiContext(value);
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitize(entry)]));
}
