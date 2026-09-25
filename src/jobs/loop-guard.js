import { fingerprintError } from '../dare/fingerprint.js';

export function shouldBlockRepeatedAction(history, fingerprint, now = Date.now(), windowMs = 10 * 60_000, maxAttempts = 1) {
  if (!history || history.fingerprint !== fingerprint) return false;
  const last = Date.parse(history.lastAt || '');
  if (!Number.isFinite(last) || now - last > windowMs) return false;
  return Number(history.attempts || 0) >= maxAttempts;
}

export function nextRepeatState(history, fingerprint, now = Date.now()) {
  const same = history?.fingerprint === fingerprint && Number.isFinite(Date.parse(history?.lastAt || ''))
    ? Number.isFinite(now - Date.parse(history.lastAt))
    : false;
  return {
    fingerprint,
    attempts: same ? Number(history.attempts || 0) + 1 : 1,
    lastAt: new Date(now).toISOString(),
  };
}

export function repairFingerprint({ feedback = '', runtime = {} } = {}) {
  const evidence = [runtime?.error, runtime?.logs, runtime?.brief, feedback].filter(Boolean).join('\n');
  const fp = fingerprintError(evidence);
  if (fp && fp !== 'NONE' && fp !== 'UNKNOWN') return fp;
  return `USER:${String(feedback || '').toLowerCase().replace(/\d{2,}/g, '#').replace(/https?:\/\/\S+/g, 'URL').replace(/\s+/g, ' ').trim().slice(0, 900)}`;
}
