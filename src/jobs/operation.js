/**
 * Thin operation-state contract shared by Create/Improve/Repair/Upgrade/Publish.
 * Does not replace JobQueue — persists resumable metadata beside jobs.
 */
import { uuid } from '../utils/ids.js';
import { sha256 } from '../utils/hash.js';

export const TERMINAL = Object.freeze({
  DONE: 'DONE',
  FAILED: 'FAILED',
  NEEDS_USER_ACTION: 'NEEDS_USER_ACTION',
  BLOCKED: 'BLOCKED',
  NO_CHANGE: 'NO_CHANGE',
  ROLLED_BACK: 'ROLLED_BACK',
  PAUSED: 'PAUSED',
  ALREADY_PUBLISHED: 'ALREADY_PUBLISHED',
});

export function makeIdempotencyKey({ projectId, action, sourceHash, request }) {
  const normalized = String(request || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
  return sha256(`${projectId || ''}|${action || ''}|${sourceHash || ''}|${normalized}`);
}

export function createOperationRecord({
  projectId,
  operationType,
  parentOperationId = null,
  sourceHashBefore = null,
  request = '',
  fingerprint = null,
} = {}) {
  const now = new Date().toISOString();
  const operationId = uuid();
  return {
    operationId,
    projectId,
    operationType,
    parentOperationId,
    sourceHashBefore,
    sourceHashAfter: null,
    evidenceHash: null,
    fingerprint,
    fingerprintHistory: fingerprint ? [fingerprint] : [],
    attempt: 0,
    maxAttempts: 3,
    changedFiles: [],
    expectedFiles: [],
    validationResults: {},
    runtimeEvidence: null,
    progressState: 'CREATED',
    rollbackCheckpoint: null,
    terminalState: null,
    security: { notices: [], warnings: [], critical: [] },
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    idempotencyKey: makeIdempotencyKey({ projectId, action: operationType, sourceHash: sourceHashBefore, request }),
    request: String(request || '').slice(0, 2000),
  };
}

export function markProgress(op, progressState, extra = {}) {
  return {
    ...op,
    ...extra,
    progressState,
    updatedAt: new Date().toISOString(),
  };
}

export function finishOperation(op, terminalState, extra = {}) {
  const now = new Date().toISOString();
  return {
    ...op,
    ...extra,
    terminalState,
    progressState: terminalState,
    finishedAt: now,
    updatedAt: now,
  };
}

export function recordFingerprint(op, fingerprint) {
  if (!fingerprint) return op;
  const history = Array.isArray(op.fingerprintHistory) ? op.fingerprintHistory.slice(-20) : [];
  if (history[history.length - 1] !== fingerprint) history.push(fingerprint);
  return {
    ...op,
    fingerprint,
    fingerprintHistory: history,
    attempt: op.fingerprint === fingerprint ? Number(op.attempt || 0) + 1 : 1,
    updatedAt: new Date().toISOString(),
  };
}

export function hasNoProgressLoop(op, { maxSame = 2 } = {}) {
  if (!op?.fingerprint) return false;
  return Number(op.attempt || 0) >= maxSame;
}

export function formatUserReport(op, {
  problem = '',
  changed = [],
  effect = '',
  verify = {},
  next = '',
} = {}) {
  const result = op.terminalState || op.progressState || 'UNKNOWN';
  const lines = [
    `RESULT: ${result}`,
    problem ? `PROBLEM: ${problem}` : null,
    changed?.length ? `CHANGED: ${changed.join(', ')}` : 'CHANGED: none',
    effect ? `EFFECT: ${effect}` : null,
    `VERIFY: build=${verify.build || '—'} run=${verify.run || '—'} smoke=${verify.smoke || '—'} http=${verify.http || '—'}`,
  ];
  if (op.security?.warnings?.length || op.security?.notices?.length) {
    lines.push(`SECURITY: ${(op.security.warnings || []).length} warning(s), ${(op.security.notices || []).length} notice(s)`);
  }
  if (op.rollbackCheckpoint) lines.push(`ROLLBACK: checkpoint ${op.rollbackCheckpoint}`);
  if (next && (result === TERMINAL.NEEDS_USER_ACTION || result === TERMINAL.FAILED || result === TERMINAL.PAUSED)) {
    lines.push(`NEXT: ${next}`);
  }
  return lines.filter(Boolean).join('\n');
}
