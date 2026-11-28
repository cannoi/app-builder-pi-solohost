import { STATUS } from '../validation/status.js';

/**
 * DARE bridge (v1.10.0, D-01).
 * Calls runDare({ dryRun: true }) — a REAL dry run that never applies a patch — and maps it:
 *   no rule matched / already prepared  → PASS
 *   deterministic patch available        → WARNING (fixable deterministically, nothing written)
 *   unsafe / needs user                  → WARNING with next=USER_ACTION|AI
 *   DARE crashed                         → NOT_TESTED with the error (never a silent PASS)
 */
export async function runDareCheck(sourceDir, _projects = null, _project = null, { logs = '', extra = {} } = {}) {
  if (!sourceDir) return { ok: false, status: STATUS.NOT_AVAILABLE, error: 'no sourceDir' };
  let runDare;
  try {
    ({ runDare } = await import('../../dare/engine.js'));
  } catch (err) {
    return { ok: true, status: STATUS.NOT_AVAILABLE, error: `DARE module unavailable: ${String(err.message || err).slice(0, 160)}` };
  }
  try {
    const r = await runDare({ sourceDir, logs, extra, dryRun: true });
    if (!r || r.dryRun !== true) {
      return { ok: false, status: STATUS.FAIL, error: 'DARE returned a non-dry-run result; refusing to trust it.' };
    }
    const data = {
      ruleId: r.ruleId,
      fingerprint: r.fingerprint,
      wouldChange: r.wouldChange || [],
      risk: r.risk,
      next: r.next,
      reason: r.reason,
      findingsCount: r.matched && !r.alreadyFixed ? 1 : 0,
    };
    if (!r.matched || r.alreadyFixed) return { ok: true, status: STATUS.PASS, data };
    return { ok: true, status: STATUS.WARNING, data, error: `DARE ${r.ruleId}: ${r.reason}`.slice(0, 300) };
  } catch (err) {
    return { ok: false, status: STATUS.NOT_TESTED, error: `DARE dry run failed: ${String(err.message || err).slice(0, 200)}` };
  }
}
