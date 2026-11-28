/** Engineering Toolkit status vocabulary — never collapse these. */
export const STATUS = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  WARNING: 'WARNING',
  NOT_AVAILABLE: 'NOT_AVAILABLE',
  NOT_TESTED: 'NOT_TESTED',
});

export function isBlocking(status) {
  return status === STATUS.FAIL;
}

export function mapLegacyResult(legacy) {
  const s = String(legacy || '').toLowerCase();
  if (s === 'passed' || s === 'pass' || s === 'ok') return STATUS.PASS;
  if (s === 'failed' || s === 'fail' || s === 'error') return STATUS.FAIL;
  if (s === 'warning' || s === 'warn') return STATUS.WARNING;
  if (s === 'skipped' || s === 'unverified') return STATUS.NOT_TESTED;
  if (s === 'not_available' || s === 'unavailable' || s === 'missing') return STATUS.NOT_AVAILABLE;
  return STATUS.NOT_TESTED;
}

/** Merge step statuses: any FAIL wins; else WARNING; else NOT_AVAILABLE if all NA; else NOT_TESTED if mixed; else PASS. */
export function mergeStatuses(statuses = []) {
  const list = statuses.filter(Boolean);
  if (!list.length) return STATUS.NOT_TESTED;
  if (list.some((s) => s === STATUS.FAIL)) return STATUS.FAIL;
  if (list.some((s) => s === STATUS.WARNING)) return STATUS.WARNING;
  if (list.every((s) => s === STATUS.NOT_AVAILABLE)) return STATUS.NOT_AVAILABLE;
  if (list.some((s) => s === STATUS.NOT_TESTED || s === STATUS.NOT_AVAILABLE)) return STATUS.NOT_TESTED;
  if (list.every((s) => s === STATUS.PASS)) return STATUS.PASS;
  return STATUS.NOT_TESTED;
}

export function stepResult({ id, status, message = '', evidence = null, exitCode = null, durationMs = null } = {}) {
  return {
    id: String(id || 'unknown'),
    status: STATUS[status] ? status : mapLegacyResult(status),
    message: String(message || '').slice(0, 2000),
    evidence,
    exitCode,
    durationMs,
    at: new Date().toISOString(),
  };
}
