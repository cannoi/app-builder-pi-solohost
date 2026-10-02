import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { listFiles } from '../utils/fsx.js';

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
  try {
    const parsed = JSON.parse(pkg);
    pkgOk = Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
    if (pkgOk) pkgData = parsed;
  } catch { pkgOk = false; }
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

export async function runNodeTests(sourceDir, timeoutMs = 60000, { installDependencies = true } = {}) {
  const pkgPath = path.join(sourceDir, 'package.json');
  if (!(await exists(pkgPath))) return { status: 'skipped', reason: 'No package.json' };
  let pkg;
  try {
    pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
  } catch (err) {
    return { status: 'failed', runner: 'npm install + node --test', stage: 'package.json', error: String(err.message || err).slice(0, 1000) };
  }
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
    return { status: 'failed', runner: 'npm install + node --test', stage: 'package.json', error: 'package.json must contain a JSON object.' };
  }
  if (installDependencies) {
    const install = await exec('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'], { cwd: sourceDir, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 }).catch((err) => ({ error: String(err.stderr || err.stdout || err.message).slice(0, 4000) }));
    if (install.error) return { status: 'failed', runner: 'npm install + node --test', stage: 'install', error: install.error };
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
    return { status: 'failed', runner: 'npm test', error: String(err.stderr || err.stdout || err.message).slice(0, 5000) };
  }
}

export async function runProjectBuild(sourceDir, timeoutMs = 45000) {
  const pkgPath = path.join(sourceDir, 'package.json');
  if (!(await exists(pkgPath))) return { status: 'skipped', reason: 'No package.json' };
  let pkg;
  try {
    pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
  } catch (err) {
    return { status: 'failed', error: `Invalid package.json: ${String(err.message || err).slice(0, 500)}` };
  }
  if (!pkg?.scripts?.build) return { status: 'skipped', reason: 'No build script' };
  try {
    await exec('npm', ['run', 'build'], { cwd: sourceDir, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
    return { status: 'passed', script: 'npm run build' };
  } catch (err) {
    return { status: 'failed', script: 'npm run build', error: String(err.stderr || err.stdout || err.message).slice(0, 5000) };
  }
}

export async function runSyntaxChecks(sourceDir, selectedFiles = null) {
  const files = selectedFiles || await listFiles(sourceDir);
  const candidates = [...new Set(files.map((file) => String(file).replace(/\\/g, '/')))]
    .filter((file) => /\.(?:js|mjs|cjs)$/i.test(file));
  const checks = [];
  for (let offset = 0; offset < candidates.length; offset += 8) {
    const batch = candidates.slice(offset, offset + 8);
    checks.push(...await Promise.all(batch.map(async (rel) => {
      let temporaryDir = null;
      try {
        let checkPath = path.join(sourceDir, rel);
        if (/\.js$/i.test(rel) && /^\s*(?:import\s+(?:[\w*{]|["'])|export\s+(?:default|const|let|var|function|class|\{|\*))/m.test(await fs.readFile(checkPath, 'utf8'))) {
          temporaryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-syntax-'));
          checkPath = path.join(temporaryDir, 'module.mjs');
          await fs.copyFile(path.join(sourceDir, rel), checkPath);
        }
        await exec('node', ['--check', checkPath], { timeout: 15000, maxBuffer: 256 * 1024 });
        return { file: rel, ok: true };
      } catch (err) {
        return { file: rel, ok: false, error: String(err.stderr || err.stdout || err.message).slice(0, 1600) };
      } finally {
        if (temporaryDir) await fs.rm(temporaryDir, { recursive: true, force: true });
      }
    })));
  }
  const failed = checks.filter((check) => !check.ok);
  return {
    status: failed.length ? 'failed' : candidates.length ? 'passed' : 'skipped',
    checked: checks.length,
    failed: failed.length,
    checks,
  };
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function fileContains(root, re) {
  const files = await listFiles(root);
  for (const rel of files) {
    if (/\.(js|mjs|ts|md|json)$/.test(rel)) {
      const text = await fs.readFile(path.join(root, rel), 'utf8').catch(() => '');
      if (re.test(text)) return true;
    }
  }
  return false;
}
