#!/usr/bin/env node
/**
 * Device verification for the Engineering Toolkit (v1.10.0).
 * Run on the Pi / SoloHost container:  npm run verify:device  [-- --out report.json]
 * Every line uses PASS | FAIL | WARNING | NOT_AVAILABLE | NOT_TESTED. Nothing here changes user projects.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execNamed, startControlled, groupAlive } from '../src/engineering/executor/exec.js';
import { detectChromium } from '../src/engineering/browser/agent.js';
import { getEngineeringMode } from '../src/engineering/config.js';
import { runValidationPipeline } from '../src/engineering/validation/pipeline.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const add = (id, status, detail = '') => { results.push({ id, status, detail }); console.log(`${status.padEnd(13)} ${id.padEnd(24)} ${detail}`); };

async function main() {
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  add('builder.version', 'PASS', `${pkg.version} · flag=${getEngineeringMode({})}`);
  const major = Number(process.versions.node.split('.')[0]);
  add('node.version', major >= 22 ? 'PASS' : 'FAIL', `node ${process.versions.node} (needs >= 22)`);
  add('platform', 'PASS', `${process.platform}/${process.arch} · ${os.cpus().length} CPU · ${Math.round(os.totalmem() / 1048576)} MB RAM`);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  add('process.user', uid === 0 ? 'WARNING' : 'PASS', uid === 0 ? 'running as root (container should be non-root)' : `uid ${uid}`);
  let sock = false;
  try { await fs.access('/var/run/docker.sock'); sock = true; } catch { /* expected */ }
  add('docker.socket', sock ? 'WARNING' : 'PASS', sock ? '/var/run/docker.sock is visible — the Builder never needs it' : 'not mounted');

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'verify-device-'));
  try {
    await fs.writeFile(path.join(dir, 'package.json'), '{"name":"v","version":"1.0.0","scripts":{"test":"node t.js"}}');
    await fs.writeFile(path.join(dir, 't.js'), "console.log('ok');\n");
    await fs.writeFile(path.join(dir, 'spin.js'), 'setInterval(() => {}, 1000);\n');
    const chk = await execNamed('node.check', ['t.js'], { projectRoot: dir, timeoutMs: 30_000 });
    add('executor.node_check', chk.ok ? 'PASS' : 'FAIL', `${chk.durationMs} ms`);
    const t = await execNamed('npm.test', [], { projectRoot: dir, timeoutMs: 120_000 });
    add('executor.npm_test', t.ok ? 'PASS' : (t.status === 'NOT_TESTED' ? 'NOT_AVAILABLE' : 'FAIL'), t.ok ? `${t.durationMs} ms` : String(t.error || t.stderrTail || '').slice(0, 120));
    const s = await startControlled('node.start', ['spin.js'], { projectRoot: dir, port: 0 });
    if (s.ok) {
      const pid = s.handle.pid;
      await s.handle.stop();
      add('executor.group_kill', groupAlive(pid) ? 'FAIL' : 'PASS', 'process group terminated on stop');
    } else add('executor.group_kill', 'FAIL', s.error);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }

  const chromium = await detectChromium().catch(() => null);
  add('browser.chromium', chromium ? 'PASS' : 'NOT_AVAILABLE', chromium ? String(chromium.executablePath || chromium.path || chromium) : 'browser QA will report NOT_AVAILABLE (honest), never PASS');

  const tpl = path.join(ROOT, 'templates', 'std-business-crm');
  try {
    const copy = await fs.mkdtemp(path.join(os.tmpdir(), 'verify-tpl-'));
    await fs.cp(tpl, copy, { recursive: true });
    const t0 = Date.now();
    const r = await runValidationPipeline(copy, { stopOnFail: false, runtime: true, browser: Boolean(chromium) });
    const get = (id) => r.steps.find((x) => x.id === id)?.status;
    add('validation.runtime', r.status === 'FAIL' ? 'FAIL' : 'PASS', `${r.status} in ${Date.now() - t0} ms · start=${get('runtime.start')} health=${get('http.health')} browser=${get('browser.desktop')}`);
    await fs.rm(copy, { recursive: true, force: true });
  } catch (err) { add('validation.runtime', 'FAIL', String(err.message || err).slice(0, 160)); }

  const overall = results.some((r) => r.status === 'FAIL') ? 'FAIL' : results.some((r) => r.status === 'WARNING') ? 'WARNING' : 'PASS';
  console.log(`\nOVERALL ${overall}`);
  const outIdx = process.argv.indexOf('--out');
  if (outIdx > 0 && process.argv[outIdx + 1]) {
    await fs.writeFile(process.argv[outIdx + 1], JSON.stringify({ at: new Date().toISOString(), overall, results }, null, 2));
  }
  process.exitCode = overall === 'FAIL' ? 1 : 0;
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
