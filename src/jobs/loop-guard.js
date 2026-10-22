/**
 * Loop guard: block repeated no-progress repairs.
 * Fingerprint includes provider/model + optional diff hash so a real provider switch is a new attempt (P7).
 */
import crypto from 'node:crypto';
import { fingerprintError as classifyRuntimeError } from '../dare/fingerprint.js';

export function fingerprintError(evidence = '') {
  const s = String(evidence || '')
    .toLowerCase()
    .replace(/\d{2,}/g, '#')
    .replace(/https?:\/\/\S+/g, 'URL')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1200);
  if (!s) return 'NONE';
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
}

export function shouldBlockRepeatedAction(history, fingerprint, now = Date.now(), windowMs = 10 * 60_000, maxAttempts = 2) {
  if (!history || history.fingerprint !== fingerprint) return false;
  const last = Date.parse(history.lastAt || '');
  if (!Number.isFinite(last) || now - last > windowMs) return false;
  return Number(history.attempts || 0) >= maxAttempts;
}

export function nextRepeatState(history, fingerprint, now = Date.now()) {
  const same = history?.fingerprint === fingerprint;
  return {
    fingerprint,
    attempts: same ? Number(history.attempts || 0) + 1 : 1,
    lastAt: new Date(now).toISOString(),
  };
}

export function repairFingerprint({
  feedback = '',
  runtime = {},
  provider = '',
  model = '',
  diffHash = '',
} = {}) {
  // Prefer concrete runtime classification so wording changes do not reset the guard
  const semantic = classifyRuntimeError(String(runtime?.error || runtime?.logs || ''));
  if (semantic && semantic !== 'NONE' && semantic !== 'UNKNOWN') return semantic;
  const evidence = [
    runtime?.error,
    runtime?.logs,
    runtime?.brief,
    feedback,
    provider ? `provider:${provider}` : '',
    model ? `model:${model}` : '',
    diffHash ? `diff:${diffHash}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const fp = fingerprintError(evidence);
  if (fp && fp !== 'NONE' && fp !== 'UNKNOWN') return fp;
  return `USER:${String(feedback || '')
    .toLowerCase()
    .replace(/\d{2,}/g, '#')
    .replace(/https?:\/\/\S+/g, 'URL')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 900)}`;
}

export function shouldStopNoProgress({
  fingerprint,
  previousFingerprint,
  attempt = 0,
  validationImproved = false,
  sourceChanged = false,
  maxAttempts = 2,
} = {}) {
  if (validationImproved || (sourceChanged && fingerprint !== previousFingerprint)) return false;
  if (!fingerprint) return false;
  if (fingerprint === previousFingerprint && Number(attempt) >= maxAttempts) return true;
  return false;
}

export function noChangeResult(reason = 'AI produced no filesystem change.') {
  return {
    terminalState: 'NO_CHANGE',
    reason,
    next: 'Provide a clearer request, different evidence, or a required external input.',
  };
}
