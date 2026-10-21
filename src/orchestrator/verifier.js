/**
 * Layered verifier: L0 syntax, L1 acceptance, L3 critical security only.
 * P5: dependency unavailable → DEP_UNAVAILABLE (replan signal), not hard fail when offline.
 * P6: can write task smoke test file under tests/.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function checkJsSyntax(filePath) {
  const r = spawnSync(process.execPath, ['--check', filePath], { encoding: 'utf8' });
  return { ok: r.status === 0, stderr: (r.stderr || '').slice(0, 500) };
}

export function runGrepAcceptance(root, spec) {
  const [filePart, ...rest] = String(spec).split(':');
  const reSrc = rest.length ? rest.join(':') : filePart;
  let re;
  try {
    re = new RegExp(reSrc, 'i');
  } catch {
    return { ok: false, detail: 'invalid regex' };
  }
  const walk = (dir, out = []) => {
    if (!fs.existsSync(dir)) return out;
    for (const name of fs.readdirSync(dir)) {
      if (['node_modules', '.git', 'data'].includes(name)) continue;
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p, out);
      else if (/\.(js|mjs|cjs|html|css|json|yml|md)$/i.test(name)) out.push(p);
    }
    return out;
  };
  const files = rest.length && filePart ? [path.join(root, filePart)] : walk(root);
  for (const f of files) {
    try {
      if (re.test(fs.readFileSync(f, 'utf8'))) return { ok: true, file: f };
    } catch { /* skip */ }
  }
  return { ok: false, detail: 'pattern not found' };
}

export function writeTaskSmokeTest(projectDir, task) {
  const dir = path.join(projectDir, 'tests');
  fs.mkdirSync(dir, { recursive: true });
  const id = String(task?.id || 'task').replace(/[^\w-]/g, '');
  const file = path.join(dir, `${id}.smoke.js`);
  const body = `// Auto-generated smoke for ${id}: ${String(task?.goal || '').slice(0, 120)}
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
test('${id} smoke: project still has entry files', () => {
  const has = ['package.json', 'public/index.html', 'index.html', 'server.js', 'src/server.js']
    .some((f) => fs.existsSync(path.join(root, f)));
  assert.ok(has, 'expected an app entry file');
});
`;
  fs.writeFileSync(file, body);
  return path.relative(projectDir, file);
}

export async function verifyTask({
  projectDir,
  task,
  changedFiles = [],
  scanBefore = null,
  scanAfter = null,
  depStatus = null, // { ok, code: 'DEP_UNAVAILABLE'|null }
  writeSmoke = true,
} = {}) {
  const results = { l0: [], l1: [], l3: null, ok: true, dep: depStatus, smokeFile: null };

  if (depStatus && depStatus.code === 'DEP_UNAVAILABLE') {
    results.ok = false;
    results.replanHint = 'zero-dependency alternative';
    return results;
  }

  for (const f of changedFiles) {
    if (/\.(js|mjs|cjs)$/i.test(f)) {
      const full = path.isAbsolute(f) ? f : path.join(projectDir, f);
      if (fs.existsSync(full)) {
        const c = checkJsSyntax(full);
        results.l0.push({ file: f, ...c });
        if (!c.ok) results.ok = false;
      }
    }
  }

  for (const acc of task?.acceptance || []) {
    if (acc.type === 'grep') {
      const g = runGrepAcceptance(projectDir, acc.spec);
      results.l1.push({ type: 'grep', ...g });
      if (!g.ok) results.ok = false;
    } else if (acc.type === 'node-check') {
      results.l1.push({ type: 'node-check', ok: results.l0.every((x) => x.ok !== false) });
    }
  }

  if (scanBefore && scanAfter) {
    const block = Number(scanAfter.critical || 0) > Number(scanBefore.critical || 0);
    results.l3 = {
      ok: !block,
      criticalBefore: scanBefore.critical,
      criticalAfter: scanAfter.critical,
      warningsAfter: scanAfter.warning,
    };
    if (block) results.ok = false;
  }

  if (writeSmoke && results.ok && task?.id) {
    try {
      results.smokeFile = writeTaskSmokeTest(projectDir, task);
    } catch { /* non-fatal */ }
  }

  return results;
}
