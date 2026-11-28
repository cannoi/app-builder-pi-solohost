/**
 * DARE v2 engine (v1.10.0, M4). Plans from toolkit findings; applies one rule at a time.
 * Every applied rule: checkpoint → write ONLY the planned files (path-safe) → verify the changed set
 * equals the planned set (else restore) → caller re-validates and rolls back on regression.
 * Legacy DARE rules are reachable through runDare({ dryRun }) as a fallback.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { RULES, AI_ONLY_KINDS, findingName } from './rules-v2.js';
import { sourceManifest, manifestDiff } from '../engineering/guard.js';
import { filterPatchFiles } from '../jobs/path-safety.js';

/** Stable report shape shared by dry-run and apply. */
function report(fields) {
  return { ok: true, ruleId: null, fingerprint: null, wouldChange: [], changed: [], risk: null, next: 'NONE', summary: '', ...fields };
}

/**
 * @param {{ sourceDir: string, findings: object[], fingerprint?: object, skip?: Set<string> }} opts
 * @returns {Promise<object>} plan report (never writes)
 */
export async function planDareV2({ sourceDir, findings = [], fingerprint = {}, skip = new Set() } = {}) {
  const fs2 = findings.map((f) => ({ ...f, name: f.name || findingName(f) }));
  for (const r of RULES) {
    for (const f of fs2) {
      if (!r.match(f)) continue;
      const p = await r.detect(f, { dir: sourceDir, fingerprint, findings: fs2 }).catch(() => null);
      if (!p) continue;
      const fp = `${r.id}:${p.fingerprint}`;
      if (skip.has(fp)) continue;
      return report({ ruleId: r.id, fingerprint: fp, wouldChange: p.files.map((x) => x.path), risk: r.risk, next: 'APPLY', summary: p.summary, plan: p });
    }
  }
  const aiOnly = fs2.filter((f) => AI_ONLY_KINDS.has(f.kind) || f.status === 'FAIL');
  return report({ next: aiOnly.length ? 'AI' : 'NONE', summary: aiOnly.length ? `${aiOnly.length} finding(s) need AI with evidence` : 'no deterministic rule applies' });
}

/** Apply a planned rule. Only planned files may change; anything else is restored and the call fails. */
export async function applyDareV2Plan(sourceDir, planned) {
  if (!planned?.plan?.files?.length) return report({ ok: false, next: 'NONE', summary: 'nothing to apply' });
  const checked = await filterPatchFiles({ sourceDir, files: planned.plan.files, allowedNew: planned.plan.files.map((f) => f.path), maxNew: 2 });
  const safe = checked.files;
  const rejected = checked.rejected;
  if (rejected.length || !safe.length) return report({ ...planned, ok: false, next: 'AI', summary: `unsafe paths rejected: ${rejected.join(', ')}` });
  const before = await sourceManifest(sourceDir);
  const originals = new Map();
  for (const f of safe) originals.set(f.path, await fs.readFile(path.join(sourceDir, f.path), 'utf8').catch(() => null));
  for (const f of safe) {
    const abs = path.join(sourceDir, f.path);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, f.content, 'utf8');
  }
  const changed = manifestDiff(before, await sourceManifest(sourceDir));
  const planned2 = new Set(safe.map((f) => f.path));
  const extra = changed.filter((c) => !planned2.has(c));
  if (extra.length) {
    for (const [rel, orig] of originals) {
      if (orig == null) await fs.rm(path.join(sourceDir, rel), { force: true }); else await fs.writeFile(path.join(sourceDir, rel), orig, 'utf8');
    }
    return report({ ...planned, ok: false, next: 'AI', summary: `patch touched unplanned files: ${extra.join(', ')}` });
  }
  return report({ ...planned, changed, next: 'REVALIDATE', plan: undefined, originals: Object.fromEntries(originals) });
}

/** Restore the exact pre-rule content of a rule's files (used when re-validation regresses). */
export async function revertDareV2(sourceDir, applied) {
  for (const [rel, orig] of Object.entries(applied?.originals || {})) {
    if (orig == null) await fs.rm(path.join(sourceDir, rel), { force: true });
    else await fs.writeFile(path.join(sourceDir, rel), orig, 'utf8');
  }
}
