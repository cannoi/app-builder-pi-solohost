/**
 * Verified repair loop (v1.10.0, M2/M4):
 *   validate → DARE v2 deterministic rule (checkpointed) → AI repair with evidence (checkpointed)
 *   → re-validate → keep only if the score did not regress and no NEW failure appeared; else roll back.
 * Bounded: ≤ 3 deterministic + ≤ 2 AI attempts by default; stops on no progress (same findings twice).
 * ENV_* failures (environment, network, toolchain) are never sent to AI repair.
 */
import { planDareV2, applyDareV2Plan, revertDareV2 } from '../../dare/engine-v2.js';
import { validationScore, collectFindings } from '../validation/pipeline.js';
import { buildEvidence } from '../evidence.js';
import { STATUS } from '../validation/status.js';

const failIds = (r) => new Set((r?.steps || []).filter((s) => s.status === STATUS.FAIL && s.id !== 'report').map((s) => s.id));
const keyOf = (r) => collectFindings(r).filter((f) => f.status === STATUS.FAIL).map((f) => `${f.step}|${f.kind}|${f.file}|${f.line}`).sort().join(';');
const envOnly = (r) => {
  const fails = (r?.steps || []).filter((s) => s.status === STATUS.FAIL && s.id !== 'report');
  return fails.length > 0 && fails.every((s) => /^ENV_/.test(s.evidence?.classification?.class || s.evidence?.class || ''));
};

/**
 * true when `after` is not worse than `before`: no newly failing step and the penalty score
 * (validationScore: FAIL=10, WARNING=1 — lower is better) did not grow.
 */
export function notWorse(before, after) {
  const b = failIds(before);
  for (const id of failIds(after)) if (!b.has(id)) return false;
  return validationScore(after) <= validationScore(before);
}

/**
 * @param {{
 *   sourceDir: string,
 *   validate: () => Promise<object>,
 *   aiRepair?: (ctx: { report: object, evidence: object, attempt: number }) => Promise<{ files: object[] } | null>,
 *   applyFiles?: (files: object[], label: string) => Promise<{ checkpointId?: string }>,
 *   restore?: (checkpointId: string) => Promise<void>,
 *   budget?: { deterministic?: number, ai?: number },
 *   task?: string, emit?: Function, initialReport?: object,
 * }} opts
 */
export async function runVerifiedRepairLoop({ sourceDir, validate, aiRepair = null, applyFiles = null, restore = null, budget = {}, task = '', emit = () => {}, initialReport = null } = {}) {
  const maxDet = budget.deterministic ?? 3;
  const maxAi = budget.ai ?? 2;
  let report = initialReport || await validate();
  const history = [{ step: 'initial', status: report.status, score: validationScore(report) }];
  const skip = new Set();
  const seen = new Set([keyOf(report)]);
  let det = 0;
  let aiCalls = 0;
  let stopReason = null;

  while (report.status === STATUS.FAIL) {
    if (envOnly(report)) { stopReason = 'environment failure (ENV_*) — not an app defect; no AI repair'; break; }
    const findings = collectFindings(report).map((f) => ({ ...f, name: f.name || null }));
    // 1) deterministic
    if (det < maxDet) {
      const planned = await planDareV2({ sourceDir, findings, fingerprint: report.fingerprint || (report.steps || []).find((s) => s.id === 'intel.fingerprint')?.evidence || {}, skip });
      if (planned.next === 'APPLY') {
        det += 1;
        skip.add(planned.fingerprint);
        const applied = await applyDareV2Plan(sourceDir, planned);
        if (!applied.ok) { history.push({ step: 'dare', ruleId: planned.ruleId, status: 'REJECTED', note: applied.summary }); continue; }
        emit({ type: 'dare', ruleId: planned.ruleId, summary: planned.summary });
        const next = await validate();
        if (notWorse(report, next)) {
          history.push({ step: 'dare', ruleId: planned.ruleId, status: next.status, score: validationScore(next), files: applied.changed });
          report = next;
          seen.add(keyOf(report));
        } else {
          await revertDareV2(sourceDir, applied);
          history.push({ step: 'dare', ruleId: planned.ruleId, status: 'ROLLED_BACK', score: validationScore(next) });
        }
        continue;
      }
    }
    // 2) AI with evidence
    if (!aiRepair || !applyFiles || aiCalls >= maxAi) { stopReason = aiCalls >= maxAi ? 'AI repair budget reached' : 'no deterministic rule applies and AI repair is not available'; break; }
    aiCalls += 1;
    const evidence = await buildEvidence({ sourceDir, task, report, stage: `repair attempt ${aiCalls}/${maxAi}` });
    const proposal = await aiRepair({ report, evidence, attempt: aiCalls }).catch((err) => ({ error: err }));
    if (!proposal?.files?.length) { stopReason = proposal?.error ? `AI repair failed: ${String(proposal.error.message || proposal.error).slice(0, 160)}` : 'AI returned no change'; break; }
    const applied = await applyFiles(proposal.files, `verified-repair-${aiCalls}`);
    const next = await validate();
    if (notWorse(report, next)) {
      history.push({ step: 'ai', attempt: aiCalls, status: next.status, score: validationScore(next), files: proposal.files.map((f) => f.path) });
      report = next;
      const k = keyOf(report);
      if (seen.has(k) && report.status === STATUS.FAIL) { stopReason = 'no progress (same failures repeated)'; break; }
      seen.add(k);
    } else {
      if (restore && applied?.checkpointId) await restore(applied.checkpointId);
      history.push({ step: 'ai', attempt: aiCalls, status: 'ROLLED_BACK', score: validationScore(next) });
    }
  }

  return {
    status: report.status,
    ok: report.status !== STATUS.FAIL,
    report,
    deterministicApplied: history.filter((h) => h.step === 'dare' && h.status !== 'ROLLED_BACK' && h.status !== 'REJECTED').length,
    aiCalls,
    rolledBack: history.filter((h) => h.status === 'ROLLED_BACK').length,
    history,
    stopReason,
  };
}
