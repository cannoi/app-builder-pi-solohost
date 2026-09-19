import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function runStaticTests(sourceDir) {
  const checks = [];
  const need = ['package.json', 'README.md', 'Dockerfile', '.env.example'];
  for (const n of need) {
    const ok = await exists(path.join(sourceDir, n));
    checks.push({ category: 'UNIT', name: `${n} present`, ok });
  }
  const env = await fs.readFile(path.join(sourceDir, '.env'), 'utf8').catch(() => '');
  checks.push({ category: 'SECURITY', name: 'No committed .env', ok: !env });
  const pkg = await fs.readFile(path.join(sourceDir, 'package.json'), 'utf8').catch(() => '');
  let pkgOk = false;
  let pkgData = {};
  try { pkgData = JSON.parse(pkg); pkgOk = true; } catch { pkgOk = false; }
  checks.push({ category: 'UNIT', name: 'package.json valid', ok: pkgOk && Boolean(pkg) });

  const dockerfile = await fs.readFile(path.join(sourceDir, 'Dockerfile'), 'utf8').catch(() => '');
  checks.push({ category: 'INTEGRATION', name: 'Dockerfile exists', ok: Boolean(dockerfile) });
  checks.push({ category: 'SECURITY', name: 'Dockerfile not privileged', ok: !/privileged/.test(dockerfile) });
  checks.push({ category: 'INTEGRATION', name: 'Container exposes port 8080', ok: /EXPOSE\s+8080\b/i.test(dockerfile) });
  const deps = Object.keys(pkgData.dependencies || {});
  if (deps.length) checks.push({ category: 'INTEGRATION', name: 'Production dependencies installed', ok: /npm\s+(ci|install)\b/i.test(dockerfile) });

  const healthHint = await fileContains(sourceDir, /\/health/);
  checks.push({ category: 'API', name: 'Health endpoint referenced', ok: healthHint });

  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.filter((c) => !c.ok).length;
  return {
    status: failed === 0 ? 'passed' : 'failed',
    passed,
    failed,
    checks,
  };
}

export async function runNodeTests(sourceDir, timeoutMs = 60000) {
  const pkgPath = path.join(sourceDir, 'package.json');
  if (!(await exists(pkgPath))) return { status: 'skipped', reason: 'No package.json' };
  const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8').catch(() => '{}'));
  const install = await exec('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: sourceDir, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 }).catch((err) => ({ error: String(err.stderr || err.stdout || err.message).slice(0, 4000) }));
  if (install.error) return { status: 'failed', runner: 'npm install + node --test', stage: 'install', error: install.error };
  try {
    await exec('npm', ['test', '--', '--test-reporter=spec'], { cwd: sourceDir, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
    let build = null;
    if (pkg.scripts?.build) {
      await exec('npm', ['run', 'build'], { cwd: sourceDir, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
      build = 'passed';
    }
    return { status: 'passed', runner: 'npm test', build };
  } catch (err) {
    return { status: 'failed', runner: 'npm test', error: String(err.stderr || err.stdout || err.message).slice(0, 5000) };
  }
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function fileContains(root, re) {
  const { listFiles } = await import('../utils/fsx.js');
  const files = await listFiles(root);
  for (const rel of files) {
    if (/\.(js|mjs|ts|md|json)$/.test(rel)) {
      const text = await fs.readFile(path.join(root, rel), 'utf8').catch(() => '');
      if (re.test(text)) return true;
    }
  }
  return false;
}
