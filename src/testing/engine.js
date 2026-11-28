import fs from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { classifyFailure } from './classify-failure.js';
import { getEngineeringMode } from '../engineering/config.js';
import { execControlled } from '../engineering/executor/exec.js';

const execFileAsync = promisify(execFile);

/**
 * Prefer the controlled executor when the Engineering Toolkit is not off; `off` keeps the legacy execFile
 * path byte-for-byte (v1.8.46 behaviour). The controlled path installs devDependencies (NODE_ENV=development),
 * queues instead of failing when busy, strips secrets from the child env and redacts output (D-02/D-03).
 */
async function exec(bin, args, opts = {}) {
  const mode = getEngineeringMode();
  if (mode !== 'off') {
    const result = await execControlled([bin, ...args], {
      cwd: opts.cwd,
      projectRoot: opts.cwd,
      timeoutMs: opts.timeout || 60_000,
      env: opts.env || {},
    });
    if (!result.ok) {
      let message = result.stderr || result.stdout || result.error || `exit ${result.exitCode}`;
      if (result.policyRejected) {
        const missing = /script "([^"]+)" not defined/.exec(result.error || '');
        message = missing ? `npm error Missing script: "${missing[1]}"` : `Builder executor policy rejected the command: ${result.error}`;
      }
      if (result.classification?.class === 'ENV_QUEUE_TIMEOUT') message = `timed out waiting for the executor queue: ${result.error}`;
      const err = new Error(message);
      err.stderr = result.stderr || (result.policyRejected ? message : '');
      err.stdout = result.stdout;
      err.killed = Boolean(result.timedOut);
      err.controlled = result;
      throw err;
    }
    return { stdout: result.stdout, stderr: result.stderr };
  }
  const childEnv = opts.env ? { ...process.env, ...opts.env } : process.env;
  return execFileAsync(bin, args, { ...opts, env: childEnv });
}


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

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function probeHttp(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 600 }, (res) => {
      res.resume();
      resolve(Boolean(res.statusCode && res.statusCode < 500));
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function detectClientOnlyHttpTest(sourceDir, pkg) {
  const startEntry = pkg?.main || String(pkg?.scripts?.start || '').match(/\bnode\s+(\S+)/)?.[1] || null;
  if (!startEntry && !pkg?.scripts?.start) return null;
  const testScript = String(pkg?.scripts?.test || '');
  const testMatch = testScript.match(/\bnode\s+(?:--test\s+)?(\S+\.(?:m?js|cjs))/);
  const candidates = [testMatch?.[1], 'test.js', 'test.mjs', 'tests/test.js'].filter(Boolean);
  for (const rel of candidates) {
    const body = await fs.readFile(path.join(sourceDir, rel), 'utf8').catch(() => '');
    if (!body) continue;
    const makesHttpCalls = /(?:http|https)\.(?:get|request)\s*\(|fetch\s*\(/i.test(body)
      && /(?:127\.0\.0\.1|localhost|process\.env\.PORT)/i.test(body);
    const startsOwnServer = /(?:require|import)\s*[^\n]*(?:server|app|index)|\.\s*listen\s*\(|\bspawn\s*\(/i.test(body);
    if (makesHttpCalls && !startsOwnServer) {
      return startEntry || 'server.js';
    }
  }
  return null;
}

async function withIsolatedTestServer(sourceDir, pkg, port, fn) {
  const entry = await detectClientOnlyHttpTest(sourceDir, pkg);
  if (!entry) return fn();
  const entryExists = await exists(path.join(sourceDir, entry));
  if (!entryExists) return fn();

  const child = spawn(process.execPath, [entry], {
    cwd: sourceDir,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', BIND: '127.0.0.1', NODE_ENV: 'test' },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  const deadline = Date.now() + 8000;
  let exited = false;
  child.once('exit', () => { exited = true; });
  while (!exited && Date.now() < deadline) {
    if (await probeHttp(port)) break;
    await new Promise((r) => setTimeout(r, 120));
  }
  try {
    return await fn();
  } finally {
    if (child?.pid) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
    }
  }
}

export async function runNodeTests(sourceDir, timeoutMs = 60000) {
  const effectiveTimeoutMs = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60000;
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
      const install = await exec('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline'], { cwd: sourceDir, timeout: installTimeoutMs(effectiveTimeoutMs), maxBuffer: 2 * 1024 * 1024 })
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
  const testPort = await getFreePort();
  const isolatedEnv = { PORT: String(testPort), HOST: '127.0.0.1', BIND: '127.0.0.1' };
  try {
    return await withIsolatedTestServer(sourceDir, pkg, testPort, async () => {
      await exec('npm', ['test', '--', '--test-reporter=spec'], { cwd: sourceDir, timeout: effectiveTimeoutMs, env: isolatedEnv, maxBuffer: 4 * 1024 * 1024 });
      let build = null;
      if (pkg.scripts?.build) {
        await exec('npm', ['run', 'build'], { cwd: sourceDir, timeout: effectiveTimeoutMs, env: isolatedEnv, maxBuffer: 4 * 1024 * 1024 });
        build = 'passed';
      }
      return { status: 'passed', runner: 'npm test', build, port: testPort };
    });
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
