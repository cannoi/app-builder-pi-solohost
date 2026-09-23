export function shouldBlockRepeatedAction(history, fingerprint, now = Date.now(), windowMs = 10 * 60_000, maxAttempts = 2) {
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
