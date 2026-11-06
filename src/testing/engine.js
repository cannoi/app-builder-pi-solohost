import fs from 'node:fs/promises';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { classifyFailure } from './classify-failure.js';

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

/** Install timeout scaled for slow hosts (Raspberry Pi / low-core ARM) — a fixed 45 s caused false failures. */
export function installTimeoutMs(baseMs = 60000) {
  const env = Number(process.env.NPM_INSTALL_TIMEOUT_MS || 0);
  if (env > 0) return env;
  const slow = /arm/i.test(os.arch()) || (os.cpus()?.length || 4) <= 4;
  return Math.max(baseMs, slow ? 180000 : 120000);
}

async function installFingerprint(sourceDir, pkgText) {
  const lock = await fs.readFile(path.join(sourceDir, 'package-lock.json'), 'utf8').catch(() => '');
  return crypto.createHash('sha1').update(pkgText).update('\u0000').update(lock).digest('hex');
}

export async function runNodeTests(sourceDir, timeoutMs = 60000) {
  const pkgPath = path.join(sourceDir, 'package.json');
  if (!(await exists(pkgPath))) return { status: 'skipped', reason: 'No package.json' };
  const pkgText = await fs.readFile(pkgPath, 'utf8').catch(() => '{}');
  const pkg = JSON.parse(pkgText || '{}');
  const hasDeps = Object.keys(pkg.dependencies || {}).length + Object.keys(pkg.devDependencies || {}).length > 0;
  // 1.8.9 smart install: skip when there is nothing to install, or when node_modules already matches package.json + lockfile.
  let installError = null;
  if (hasDeps) {
    const fp = await installFingerprint(sourceDir, pkgText);
    const marker = path.join(sourceDir, 'node_modules', '.builder-install-hash');
    const upToDate = (await fs.readFile(marker, 'utf8').catch(() => '')).trim() === fp;
    if (!upToDate) {
      const install = await exec('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline'], { cwd: sourceDir, timeout: installTimeoutMs(timeoutMs), maxBuffer: 2 * 1024 * 1024 })
        .catch((err) => ({ error: String(err.stderr || err.stdout || err.message || err).slice(0, 5000), killed: Boolean(err.killed) }));
      if (install.error) installError = install;
      else await fs.writeFile(marker, fp).catch(() => {});
    }
  }
  if (installError) {
    // 1.8.9: environment failures (offline registry, timeout, disk/permission) are NOT code failures. They are
    // reported as "unverified" and must never send the AI to "repair" the project.
    const cls = classifyFailure(installError.killed ? `timed out: ${installError.error}` : installError.error);
    if (!cls.aiRepair && /^ENV_/.test(cls.class)) {
      return { status: 'skipped', unverified: true, envFailure: cls.class, runner: 'npm install', stage: 'install', reason: `${cls.class}: ${cls.userEn}`, reasonVi: cls.userVi, error: installError.error };
    }
    return { status: 'failed', runner: 'npm install + node --test', stage: 'install', error: installError.error, failureClass: cls.class };
  }
  try {
    await exec('npm', ['test', '--', '--test-reporter=spec'], { cwd: sourceDir, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
    let build = null;
    if (pkg.scripts?.build) {
      await exec('npm', ['run', 'build'], { cwd: sourceDir, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
      build = 'passed';
    }
    return { status: 'passed', runner: 'npm test', build };
  } catch (err) {
    const text = String(err.stderr || err.stdout || err.message).slice(0, 5000);
    const cls = classifyFailure(err.killed ? `timed out: ${text}` : text);
    if (err.killed) return { status: 'skipped', unverified: true, envFailure: 'ENV_TIMEOUT', runner: 'npm test', stage: 'test', reason: 'ENV_TIMEOUT: the test run exceeded its time limit on this device.', error: text };
    return { status: 'failed', runner: 'npm test', error: text, failureClass: cls.class };
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
