/**
 * Attempt ledger — no identical retry without new evidence.
 */
import { createHash } from 'node:crypto';

const META = 'agent-attempt-ledger.json';

export function fingerprint({ prompt = '', sourceHash = '', patch = '', failure = '' } = {}) {
  return createHash('sha256')
    .update([prompt, sourceHash, patch, failure].map(String).join('|'))
    .digest('hex')
    .slice(0, 24);
}

export async function loadLedger(projects, project) {
  return (await projects.readMetadata(project, META, null)) || { attempts: [] };
}

export async function recordAttempt(projects, project, attempt) {
  const ledger = await loadLedger(projects, project);
  const entry = {
    attemptId: attempt.attemptId || `att_${Date.now()}`,
    taskId: attempt.taskId || '',
    provider: attempt.provider || '',
    model: attempt.model || '',
    promptHash: attempt.promptHash || fingerprint({ prompt: attempt.prompt || '' }),
    sourceHash: attempt.sourceHash || '',
    patchHash: attempt.patchHash || fingerprint({ patch: attempt.patch || '' }),
    toolCalls: attempt.toolCalls || [],
    tests: attempt.tests || [],
    result: attempt.result || '',
    failureFingerprint: attempt.failureFingerprint || '',
    at: new Date().toISOString(),
  };
  ledger.attempts = [...(ledger.attempts || []), entry].slice(-40);
  await projects.saveMetadata(project, META, ledger);
  return entry;
}

/**
 * Returns true if the same failure fingerprint already exists without new evidence key.
 */
export function isDuplicateFailure(ledger, failureFingerprint) {
  if (!failureFingerprint) return false;
  return (ledger?.attempts || []).some((a) => a.failureFingerprint === failureFingerprint && a.result === 'failed');
}
