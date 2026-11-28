#!/usr/bin/env node
/**
 * Engineering Toolkit benchmark (v1.11.0) — reproducible, no AI calls, no network.
 *  A) every bundled template: static + runtime (+ browser when Chromium exists) validation
 *  B) seeded defects: does validation DETECT each defect, and does the verified loop (DARE v2 only)
 *     REPAIR it without AI and without touching unrelated files?
 *  C) --ab: scripted fake-model A/B comparison (off vs on) including false-positive check on healthy templates
 * Usage: node scripts/engineering-benchmark.mjs [--json out.json] [--no-browser] [--ab]
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runValidationPipeline } from '../src/engineering/validation/pipeline.js';
import { runVerifiedRepairLoop } from '../src/engineering/orchestrator/repair-loop.js';
import { sourceManifest, manifestDiff } from '../src/engineering/guard.js';
import { detectChromium } from '../src/engineering/browser/agent.js';
import { canClaimWorking } from '../src/engineering/report.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TPL = path.join(ROOT, 'templates');
const browser = !process.argv.includes('--no-browser') && Boolean(await detectChromium().catch(() => null));
const runAb = process.argv.includes('--ab');

async function copy(name) { const d = await fs.mkdtemp(path.join(os.tmpdir(), `bench-${name}-`)); await fs.cp(path.join(TPL, name), d, { recursive: true }); return d; }
async function templates() {
  const out = [];
  for (const e of await fs.readdir(TPL, { withFileTypes: true })) {
    if (e.isDirectory() && e.name !== 'catalog') { try { await fs.access(path.join(TPL, e.name, 'package.json')); out.push(e.name); } catch { /* */ } }
  }
  return out.sort();
}
async function entryOf(dir) {
  const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
  const m = /node\s+(\S+\.m?js)/.exec(pkg.scripts?.start || '');
  return m ? m[1] : 'src/server.js';
}
const edit = async (dir, rel, fn) => { const p = path.join(dir, rel); await fs.writeFile(p, fn(await fs.readFile(p, 'utf8'))); };

// Each defect: inject(dir) → expected failing/warning step ids; deterministic=true when DARE v2 should fix it.
const DEFECTS = [
  { id: 'fixed-port', deterministic: true, expect: ['config.port'], inject: async (d) => edit(d, await entryOf(d), (t) => t.replace(/process\.env\.PORT[^,)]*/, '3000').replace(/\.listen\(\s*[A-Za-z_]+\s*,/, '.listen(3000,')) },
  { id: 'bind-localhost', deterministic: true, expect: ['config.port'], inject: async (d) => edit(d, await entryOf(d), (t) => t.replace(/['"]0\.0\.0\.0['"]/g, "'127.0.0.1'")) },
  { id: 'missing-esm-ext', deterministic: true, expect: ['code.imports'], inject: async (d) => { const e = await entryOf(d); await fs.writeFile(path.join(d, path.dirname(e), 'bench-util.js'), 'export const benchUtil = 1;\n'); await edit(d, e, (t) => `import { benchUtil } from './bench-util';\nvoid benchUtil;\n${t}`); } },
  { id: 'undeclared-env', deterministic: true, expect: ['intel.env'], inject: async (d) => edit(d, await entryOf(d), (t) => `${t}\nconst BENCH_SHOP_NAME = process.env.BENCH_SHOP_NAME || 'demo';\nvoid BENCH_SHOP_NAME;\n`) },
  { id: 'syntax-error', deterministic: false, expect: ['code.syntax_check'], inject: async (d) => edit(d, await entryOf(d), (t) => `${t}\nconst = ;\n`) },
  { id: 'ui-calls-missing-api', deterministic: false, expect: ['intel.routes'], inject: async (d) => { const f = path.join(d, 'public', 'index.html'); try { await edit(d, 'public/index.html', (t) => t.replace('</body>', "<script>fetch('/api/bench-missing-route').catch(()=>{})</script></body>")); } catch { await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, "<script>fetch('/api/bench-missing-route')</script>"); } } },
  { id: 'crash-on-start', deterministic: false, runtime: true, expect: ['runtime.start'], inject: async (d) => edit(d, await entryOf(d), (t) => `${t}\nthrow new Error('bench crash on start');\n`) },
];

const report = { at: new Date().toISOString(), node: process.versions.node, platform: `${process.platform}/${process.arch}`, browser, templates: [], defects: [] };

console.log(`# A) bundled templates (runtime${browser ? ' + browser' : ''})`);
for (const name of await templates()) {
  const dir = await copy(name);
  const before = await sourceManifest(dir);
  const t0 = Date.now();
  const r = await runValidationPipeline(dir, { stopOnFail: false, runtime: true, browser });
  const mutated = manifestDiff(before, await sourceManifest(dir)).length;
  const get = (id) => r.steps.find((x) => x.id === id)?.status;
  const row = { template: name, status: r.status, ms: Date.now() - t0, start: get('runtime.start'), health: get('http.health'), routes: get('http.routes'), browser: get('browser.desktop'), mutatedFiles: mutated, fails: r.steps.filter((x) => x.status === 'FAIL' && x.id !== 'report').map((x) => `${x.id}: ${x.message}`.slice(0, 160)) };
  report.templates.push(row);
  console.log(`${row.status.padEnd(8)} ${name.padEnd(28)} start=${row.start} health=${row.health} routes=${row.routes} browser=${row.browser} ${row.ms}ms${row.fails.length ? `\n         ${row.fails.join('\n         ')}` : ''}`);
  await fs.rm(dir, { recursive: true, force: true });
}

console.log('\n# B) seeded defects on std-* templates (detection + deterministic repair, no AI)');
const stdTemplates = (await templates()).filter((n) => n.startsWith('std-'));
for (const defect of DEFECTS) {
  let detected = 0; let repaired = 0; let unrelatedTouched = 0; let total = 0;
  for (const name of stdTemplates) {
    const dir = await copy(name);
    try {
      await defect.inject(dir);
      total += 1;
      const validate = () => runValidationPipeline(dir, { stopOnFail: false, runtime: Boolean(defect.runtime), browser: false });
      const r = await validate();
      if (defect.expect.some((id) => ['FAIL', 'WARNING'].includes(r.steps.find((x) => x.id === id)?.status))) detected += 1;
      if (defect.deterministic) {
        const before = await sourceManifest(dir);
        const loop = await runVerifiedRepairLoop({ sourceDir: dir, validate, initialReport: r.status === 'FAIL' ? r : null });
        // WARNING-level defects (env) are fixed by planning once from the findings even when nothing FAILs
        let after = loop.report;
        if (r.status !== 'FAIL') {
          const { planDareV2, applyDareV2Plan } = await import('../src/dare/engine-v2.js');
          const p = await planDareV2({ sourceDir: dir, findings: r.findings });
          if (p.next === 'APPLY') await applyDareV2Plan(dir, p);
          after = await validate();
        }
        const still = defect.expect.some((id) => ['FAIL', 'WARNING'].includes(after.steps.find((x) => x.id === id)?.status));
        if (!still && after.status !== 'FAIL') repaired += 1;
        const changed = manifestDiff(before, await sourceManifest(dir));
        if (changed.some((c) => !/(server\.js|\.env\.example|package\.json)$/.test(c))) unrelatedTouched += 1;
      }
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  }
  const row = { defect: defect.id, templates: total, detected, detectionRate: total ? Math.round((detected / total) * 100) : 0, deterministic: defect.deterministic, repaired: defect.deterministic ? repaired : null, repairRate: defect.deterministic && total ? Math.round((repaired / total) * 100) : null, unrelatedTouched: defect.deterministic ? unrelatedTouched : null };
  report.defects.push(row);
  console.log(`${defect.id.padEnd(22)} detected ${detected}/${total} (${row.detectionRate}%)${defect.deterministic ? ` · repaired ${repaired}/${total} (${row.repairRate}%) · unrelated files touched: ${unrelatedTouched}` : ' · routed to AI with evidence (not patched deterministically)'}`);
}

if (runAb) {
  console.log('\n# C) A/B scripted comparison: ENGINEERING_TOOLKIT=off vs on (no live provider)');
  const { runStaticTests } = await import('../src/testing/engine.js');
  const abCases = [
    { id: 'healthy-clean', inject: null, expectHealthy: true },
    { id: 'fixed-port', inject: DEFECTS.find((d) => d.id === 'fixed-port').inject, expectHealthy: false },
    { id: 'bind-localhost', inject: DEFECTS.find((d) => d.id === 'bind-localhost').inject, expectHealthy: false },
    { id: 'syntax-error', inject: DEFECTS.find((d) => d.id === 'syntax-error').inject, expectHealthy: false },
    { id: 'ui-calls-missing-api', inject: DEFECTS.find((d) => d.id === 'ui-calls-missing-api').inject, expectHealthy: false },
    { id: 'crash-on-start', inject: DEFECTS.find((d) => d.id === 'crash-on-start').inject, expectHealthy: false },
  ];
  const abRows = [];
  let falsePositivesOff = 0;
  let falsePositivesOn = 0;
  for (const c of abCases) {
    const dir = await copy('std-business-crm');
    try {
      await fs.writeFile(path.join(dir, '.env.example'), 'PORT=8080\n');
      if (c.inject) await c.inject(dir);
      const st = await runStaticTests(dir);
      const offClaimedPass = st.status === 'passed';
      const validate = () => runValidationPipeline(dir, { stopOnFail: false, runtime: true, browser });
      const before = await validate();
      let after = before;
      if (!c.expectHealthy && before.status === 'FAIL') {
        const entry = await entryOf(dir);
        const loop = await runVerifiedRepairLoop({
          sourceDir: dir,
          validate,
          initialReport: before,
          aiRepair: c.id === 'syntax-error' ? async () => {
            const orig = await fs.readFile(path.join(TPL, 'std-business-crm', entry), 'utf8');
            return { files: [{ path: entry, content: orig }] };
          } : null,
          applyFiles: async (files) => {
            for (const f of files) await fs.writeFile(path.join(dir, f.path), f.content, 'utf8');
            return { checkpointId: null };
          },
        });
        after = loop.report || before;
      }
      const onClaimedPass = canClaimWorking(after, { hasChromium: browser });
      if (c.expectHealthy && !offClaimedPass) falsePositivesOff += 1;
      if (c.expectHealthy && !onClaimedPass) falsePositivesOn += 1;
      const row = {
        case: c.id,
        expectedHealthy: c.expectHealthy,
        offStaticStatus: st.status,
        offTruthful: c.expectHealthy ? offClaimedPass : !offClaimedPass,
        onBeforeStatus: before.status,
        onAfterStatus: after.status,
        onWorkingClaim: onClaimedPass,
        onTruthful: c.expectHealthy ? onClaimedPass : (after.status !== 'FAIL' ? onClaimedPass : !onClaimedPass),
      };
      abRows.push(row);
      console.log(`${c.id.padEnd(22)} off=${row.offStaticStatus.padEnd(7)} onBefore=${row.onBeforeStatus.padEnd(7)} onAfter=${row.onAfterStatus.padEnd(7)} working=${row.onWorkingClaim}`);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
  report.ab = {
    cases: abRows,
    falsePositivesOff,
    falsePositivesOn,
    defectsCaughtOff: abRows.filter((r) => !r.expectedHealthy && r.offTruthful).length,
    defectsCaughtOrFixedOn: abRows.filter((r) => !r.expectedHealthy && (r.onBeforeStatus === 'FAIL' || r.onAfterStatus !== 'FAIL')).length,
  };
}

const ji = process.argv.indexOf('--json');
if (ji > 0 && process.argv[ji + 1]) await fs.writeFile(process.argv[ji + 1], JSON.stringify(report, null, 2));
