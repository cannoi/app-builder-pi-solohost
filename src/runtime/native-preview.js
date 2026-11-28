/**
 * NativePreview — Preview Engine 3.0 (Podman-free)
 *
 * Pipeline (matches the target architecture):
 *   Project Workspace → Runtime Orchestrator → Runtime (web / other)
 *   → Isolated Preview + Gateway → Browser Testing Agent → report
 *
 * Rules this engine enforces:
 *  - A preview is "passed" ONLY when a real process (or static server) answered
 *    HTTP. A failed / crashed / never-started app is never reported as passed.
 *  - Every failure carries a stable reasonCode + plain-language message (en/vi).
 *  - Ports come from a reserving allocator: concurrent previews never collide,
 *    and a port conflict is retried on a fresh port.
 *  - Each preview owns its process group; stopping one never touches another.
 *  - status() is live: it reports crashed / not_responding instead of stale "running".
 */

import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { runPlaywrightE2E } from '../testing/playwright.js';
import { PREVIEW_MIME as MIME } from '../preview-mime.js';
import { detectRuntimeProfile, commandExists } from './runtime-orchestrator.js';
import { allocatePort, releasePort } from './port-allocator.js';
import { registerPreviewSession, unregisterPreviewSession } from './preview-gateway.js';
import { reasonMessages } from './preview-messages.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const processes = new Map(); // projectSlug → preview state

// Environment variables that are NEVER passed to generated applications
const DENIED_ENV = new Set([
  'GEMINI_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
  'GITHUB_TOKEN', 'GH_TOKEN', 'GIT_TOKEN', 'NPM_TOKEN',
  'SHFH_INGEST_TOKEN', 'BUILDER_ACCESS_PASSWORD', 'ACCESS_PASSWORD',
  'DATABASE_URL', 'DB_PASSWORD', 'REDIS_URL', 'SECRET_KEY',
]);

const INSTALL_TIMEOUT_MS = 180_000;

export class NativePreview {
  constructor({ cfg, log, browserFactory = null } = {}) {
    this.cfg = cfg;
    this.log = log;
    this.browserFactory = browserFactory;
  }

  /**
   * Main entry — run the application under the right runtime and verify it.
   */
  async run({
    sourcePath,
    projectSlug,
    timeout = 180,
    keepRunning = true,
    acceptancePlan = null,
    captureImages = false,
    skipInternetProbe = false,
  }) {
    const safe = slug(projectSlug);
    const started = Date.now();
    await this.stop({ projectSlug: safe }).catch(() => {});

    // 1. Validate workspace + detect runtime
    const pkgCheck = await readPackageJson(sourcePath);
    if (pkgCheck.invalid) {
      return failure(null, 'INVALID_PACKAGE_JSON', pkgCheck.error, { phase: 'validate' });
    }
    const profile = await detectRuntimeProfile(sourcePath);
    this.log?.info?.(`[preview] runtime_id=${profile.runtime_id} framework=${profile.framework} confidence=${profile.confidence}`);

    if (!profile.preview_supported && profile.runtime_id === 'unknown') {
      return failure(null, 'NO_ENTRY', 'Nothing to preview yet. Tap Build first.', { phase: 'validate', runtimeProfile: profile });
    }
    if (!profile.preview_supported) {
      const code = profile.reason_code || (profile.runtime_id === 'container-app' ? 'CONTAINER_ONLY' : 'NO_ENTRY');
      return {
        status: 'preview_limited',
        gateStatus: 'preview_limited',
        runtime: 'native-preview',
        runtimeProfile: profile,
        reasonCode: code,
        health: false,
        error: profile.unsupported_reason || 'This app cannot be previewed here.',
        guidance: profile.guidance,
        message: profile.guidance,
      };
    }

    const state = {
      slug: safe,
      server: null,
      child: null,
      port: null,
      ownedPorts: [],
      startedAt: Date.now(),
      stdout: '',
      stderr: '',
      profile,
      pid: null,
      exit: null,
      spawnError: null,
      stopping: false,
    };
    processes.set(safe, state);

    try {
      // 2. Start the runtime
      let launched;
      if (profile.runtime_id === 'static-web') {
        launched = await this.#startStatic(sourcePath, state);
      } else {
        launched = await this.#startProcess(sourcePath, state, pkgCheck.pkg, timeout);
      }
      if (!launched.ok) {
        const res = failure(state, launched.code, launched.error, { phase: launched.phase });
        await this.stop({ projectSlug: safe });
        return res;
      }
      const port = state.port;
      const localUrl = `http://127.0.0.1:${port}`;

      // 3. Health — real HTTP answer, from OUR process
      const health = await probeHttp(port, ['/', '/health', '/__preview_health']);
      if (!health.ok) {
        const res = failure(state, 'HEALTH_FAILED', `Health check failed: ${health.error}`, { phase: 'health' });
        await this.stop({ projectSlug: safe });
        return res;
      }
      const warnings = [];
      if (health.status === 404) warnings.push('The home page returned 404 (the app answers, but "/" is empty).');

      // 4. Browser Testing Agent
      let browserResult = null;
      const requireBrowser = this.cfg?.preview?.requireBrowserTest !== false;
      if (requireBrowser) {
        try {
          browserResult = await runPlaywrightE2E({
            uiUrl: localUrl,
            timeoutMs: Math.max(15000, (timeout - 30) * 1000),
            captureImages: Boolean(captureImages),
            verificationActions: acceptancePlan?.actions || acceptancePlan?.verificationActions || null,
            strictInteraction: Boolean(acceptancePlan?.strictInteraction),
            browserFactory: this.browserFactory || null,
          });
        } catch (err) {
          browserResult = {
            status: 'failed',
            error: String(err?.message || err).slice(0, 800),
            criteria: [],
            evidence: { browserAvailable: false, loaded: false },
          };
        }
      } else {
        browserResult = { status: 'skipped', reason: 'Browser test disabled by configuration', evidence: { browserAvailable: false, loaded: true } };
      }

      // No Chromium here → keep HTTP evidence, but say so explicitly (never pretend a browser ran)
      if (browserResult?.status === 'failed') {
        const errText = String(browserResult.error || '');
        const unavailable = /Executable doesn't exist|Failed to launch|browserType\.launch|Cannot find (?:module|package) 'playwright|ERR_MODULE_NOT_FOUND|browserAvailable.: false/i.test(errText)
          || browserResult.evidence?.browserAvailable === false;
        if (unavailable) {
          browserResult = {
            ...browserResult,
            status: 'skipped',
            reason: 'No browser is available here; HTTP health is the only evidence.',
            error: browserResult.error,
            evidence: { ...(browserResult.evidence || {}), browserAvailable: false, loaded: false },
          };
        }
      }

      // 5. Optional internet probe (separate, never blocks)
      let internet = { ok: true, skipped: true };
      if (!skipInternetProbe && this.cfg?.preview?.requireInternet) internet = await checkInternet();

      // 6. Gate
      const gate = evaluatePreviewGate({ profile, health: true, browserResult });
      let pipelineStatus = gate.status === 'preview_verified' ? 'passed'
        : gate.status === 'preview_failed' ? 'failed'
          : gate.status;
      const evidenceLevel = browserResult?.status === 'passed' ? 'browser' : 'http';

      // Crash during verification? Never claim success for a dead app.
      if (pipelineStatus === 'passed' && state.exit && state.child) {
        const res = failure(state, 'PROCESS_EXITED', `The app stopped (exit code ${state.exit.code}).`, { phase: 'health' });
        await this.stop({ projectSlug: safe });
        return res;
      }

      const result = {
        status: pipelineStatus,
        gateStatus: gate.status,
        runtime: 'native-preview',
        runtimeProfile: profile,
        hostPort: port,
        url: localUrl,
        previewPath: `/preview/${safe}/`,
        health: true,
        rootStatus: health.status,
        warnings,
        browser: browserResult,
        e2e: browserResult,
        evidenceLevel,
        internet,
        gate,
        durationMs: Date.now() - started,
        stdout: clip(state.stdout),
        stderr: clip(state.stderr),
        logs: clip(`${state.stdout || ''}\n${state.stderr || ''}`),
        evidence: browserResult?.evidence || null,
        error: pipelineStatus === 'failed'
          ? (gate.reasons?.join('; ') || browserResult?.error || 'Preview verification failed')
          : undefined,
        reasonCode: pipelineStatus === 'failed' ? 'BROWSER_FAILED' : undefined,
        message: pipelineStatus === 'failed' ? reasonMessages('BROWSER_FAILED') : undefined,
      };

      if (pipelineStatus === 'passed' && keepRunning) {
        registerPreviewSession(safe, {
          upstream: localUrl,
          hostPort: port,
          engine: 'native-preview',
          runtime_id: profile.runtime_id,
        });
      }
      if (pipelineStatus !== 'passed' || !keepRunning) await this.stop({ projectSlug: safe });
      return result;
    } catch (err) {
      const res = failure(state, 'UNKNOWN', String(err?.message || err).slice(0, 1200), { phase: 'internal', logs: String(err?.stack || err?.message || err).slice(0, 2000) });
      await this.stop({ projectSlug: safe }).catch(() => {});
      return res;
    }
  }

  async stop({ projectSlug }) {
    const key = slug(projectSlug);
    const state = processes.get(key);
    unregisterPreviewSession(key);
    if (!state) return { status: 'stopped', runtime: 'native-preview', projectSlug: key };
    processes.delete(key);
    state.stopping = true;
    if (state.server) { try { state.server.closeAllConnections?.(); state.server.close(); } catch { /* */ } }
    if (state.child) {
      killProcessTree(state.child);
      const until = Date.now() + 3000;
      while (Date.now() < until && !state.exit && isAlive(state.child.pid)) await sleep(50);
      if (isAlive(state.child.pid)) { try { process.kill(-state.child.pid, 'SIGKILL'); } catch { /* */ } }
    }
    for (const p of state.ownedPorts) releasePort(p);
    state.ownedPorts = [];
    return { status: 'stopped', runtime: 'native-preview', projectSlug: key };
  }

  async stopAll() {
    const keys = [...processes.keys()];
    for (const k of keys) await this.stop({ projectSlug: k });
    return keys.length;
  }

  /**
   * Live status. Never returns "running" unless the process is alive AND the port answers.
   */
  async status({ projectSlug }) {
    const key = slug(projectSlug);
    const state = processes.get(key);
    if (!state) return { status: 'stopped', runtime: 'native-preview', hostPort: null, url: null };
    const base = { runtime: 'native-preview', hostPort: state.port, url: `http://127.0.0.1:${state.port}`, pid: state.pid, runtime_id: state.profile?.runtime_id };
    if (state.child && state.exit) {
      return { ...base, status: 'crashed', reasonCode: 'CRASHED', exitCode: state.exit.code, error: clip(state.stderr, 600), message: reasonMessages('CRASHED') };
    }
    const alive = await probeHttp(state.port, ['/', '/health', '/__preview_health'], 1500);
    if (!alive.ok) return { ...base, status: 'not_responding', reasonCode: 'HEALTH_FAILED', message: reasonMessages('HEALTH_FAILED') };
    return { ...base, status: 'running' };
  }

  listActive() {
    return [...processes.entries()].map(([k, s]) => ({ slug: k, port: s.port, pid: s.pid, runtime_id: s.profile?.runtime_id, startedAt: s.startedAt }));
  }

  // ---------------------------------------------------------------------------

  async #startStatic(sourcePath, state) {
    const publicDir = await resolvePublicDir(sourcePath);
    if (!publicDir) return { ok: false, code: 'NO_ENTRY', error: 'No index.html found for the static page.', phase: 'startup' };
    const port = await allocatePort();
    state.ownedPorts.push(port);
    const server = createStaticServer(publicDir, state.slug);
    try { await listen(server, port); } catch (err) {
      return { ok: false, code: 'PORT_CONFLICT', error: String(err?.message || err), phase: 'startup' };
    }
    state.server = server;
    state.port = port;
    state.publicDir = publicDir;
    return { ok: true };
  }

  async #startProcess(sourcePath, state, pkg, timeoutSec) {
    const profile = state.profile;

    // Dependencies (Node: lock-aware + verified; Python: venv)
    const deps = await ensureDependencies(sourcePath, profile, pkg);
    if (!deps.ok) return { ok: false, code: deps.code, error: deps.error, phase: 'install' };

    const maxAttempts = 3;
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const port = await allocatePort(state.ownedPorts);
      state.ownedPorts.push(port);
      state.port = port;
      state.stdout = ''; state.stderr = ''; state.exit = null; state.spawnError = null;

      const argv = buildLaunchArgv(profile, pkg, port, deps);
      if (!argv) return { ok: false, code: 'MISSING_START_SCRIPT', error: 'No start command was found.', phase: 'startup' };
      if (!commandExists(argv[0]) && !argv[0].includes('/')) {
        return { ok: false, code: 'TOOLCHAIN_MISSING', error: `"${argv[0]}" is not installed here.`, phase: 'startup' };
      }
      const child = spawnProcess(sourcePath, argv, port, state);
      state.child = child;
      state.pid = child.pid;

      const startupBudget = Math.max(10, Math.min(profile.runtime_id === 'vite-frontend' ? 60 : 45, timeoutSec));
      const ready = await waitForReady(state, port, startupBudget);
      if (ready.ok) {
        if (ready.port !== port) { // app ignored PORT and told us where it listens
          releasePort(port);
          state.ownedPorts = state.ownedPorts.filter((p) => p !== port);
          state.port = ready.port;
          state.ownedPorts.push(ready.port);
        }
        // Isolated Preview Gateway fallback: if Node/backend only serves /api/* + /health (GET / -> 404)
        // and the project also has public/index.html (or dist/index.html), front the backend with a
        // hybrid static + /api/* reverse proxy gateway so UI + API both resolve cleanly.
        const rootProbe = await probeHttp(state.port, ['/'], 1000);
        if (!rootProbe.ok || rootProbe.status === 404) {
          const publicDir = await resolvePublicDir(sourcePath);
          if (publicDir) {
            const gwPort = await allocatePort(state.ownedPorts);
            const gwServer = createHybridGatewayServer(publicDir, state.port, state.slug);
            try {
              await listen(gwServer, gwPort);
              state.ownedPorts.push(gwPort);
              state.server = gwServer;
              state.backendPort = state.port;
              state.port = gwPort;
              state.publicDir = publicDir;
            } catch {
              try { gwServer.close(); } catch {}
              releasePort(gwPort);
            }
          }
        }
        return { ok: true };
      }
      lastError = ready;
      killProcessTree(child);
      state.child = null;
      if (ready.code === 'PORT_CONFLICT' && attempt < maxAttempts) {
        this.log?.warn?.(`[preview] port ${port} conflict, retrying (${attempt}/${maxAttempts})`);
        continue;
      }
      break;
    }
    return { ok: false, code: lastError?.code || 'STARTUP_TIMEOUT', error: lastError?.error || 'The app did not start.', phase: 'startup' };
  }
}

// ---------------------------------------------------------------------------
// Failure + gate
// ---------------------------------------------------------------------------

function failure(state, code, error, extra = {}) {
  const stdout = clip(state?.stdout);
  const stderr = clip(state?.stderr);
  const classified = classifyFailure(code, `${stderr}\n${stdout}`);
  return {
    status: 'failed',
    runtime: 'native-preview',
    gateStatus: 'preview_failed',
    runtimeProfile: state?.profile || null,
    health: false,
    reasonCode: classified.code,
    message: reasonMessages(classified.code),
    error: classified.detail ? `${error} (${classified.detail})` : error,
    stdout,
    stderr,
    logs: clip(`${stdout}\n${stderr}\n${error || ''}`),
    ...extra,
  };
}

/** Promote a generic startup failure to a precise cause when the logs say so. */
export function classifyFailure(code, logs) {
  const text = String(logs || '');
  const missing = text.match(/Cannot find (?:module|package) '([^'/][^']*)'/);
  if (missing && ['PROCESS_EXITED', 'STARTUP_TIMEOUT', 'HEALTH_FAILED', 'MISSING_DEPENDENCY'].includes(code)) {
    return { code: 'MISSING_DEPENDENCY', detail: `missing "${missing[1]}"` };
  }
  if (/EADDRINUSE|address already in use/i.test(text) && ['PROCESS_EXITED', 'STARTUP_TIMEOUT'].includes(code)) {
    return { code: 'PORT_CONFLICT', detail: null };
  }
  if (/Missing script: "?start"?/i.test(text)) return { code: 'MISSING_START_SCRIPT', detail: null };
  return { code, detail: null };
}

function evaluatePreviewGate({ profile, health, browserResult }) {
  const reasons = [];
  if (!profile.preview_supported) {
    return { status: 'preview_limited', reasons: [profile.unsupported_reason || 'Runtime not supported for preview'] };
  }
  if (!health) reasons.push('HTTP health check failed');

  const br = browserResult || {};
  if (br.status === 'failed') reasons.push(br.error || 'Browser verification failed');
  else if (br.status && !['passed', 'skipped'].includes(br.status)) reasons.push(`Browser status: ${br.status}`);

  const criteria = br.criteria || br.actionResults || [];
  const requiredFailed = criteria.filter((c) => c.required && c.status !== 'passed' && c.status !== 'skipped');
  if (requiredFailed.length) reasons.push(`${requiredFailed.length} required acceptance criteria failed`);

  return reasons.length ? { status: 'preview_failed', reasons } : { status: 'preview_verified', reasons: [] };
}

// ---------------------------------------------------------------------------
// Package + dependencies
// ---------------------------------------------------------------------------

async function readPackageJson(sourcePath) {
  const file = path.join(sourcePath, 'package.json');
  let raw;
  try { raw = await fs.readFile(file, 'utf8'); } catch { return { pkg: null, invalid: false }; }
  try { return { pkg: JSON.parse(raw), invalid: false }; } catch (err) {
    return { pkg: null, invalid: true, error: `package.json is not valid JSON (${String(err.message).slice(0, 120)})` };
  }
}

async function exists(p) { return fs.access(p).then(() => true).catch(() => false); }

function needsDevDeps(profile, pkg) {
  if (profile.runtime_id === 'vite-frontend') return true;
  const dev = Object.keys(pkg?.devDependencies || {});
  const start = String(pkg?.scripts?.start || '');
  return dev.some((d) => new RegExp(`(^|[\\s;&|])${d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(start));
}

export async function findMissingDeps(sourcePath, pkg, includeDev) {
  const names = [...Object.keys(pkg?.dependencies || {}), ...(includeDev ? Object.keys(pkg?.devDependencies || {}) : [])];
  const missing = [];
  for (const n of names) {
    if (!(await exists(path.join(sourcePath, 'node_modules', n, 'package.json')))) missing.push(n);
  }
  return missing;
}

async function ensureDependencies(sourcePath, profile, pkg) {
  // Python: virtualenv for requirements.txt
  if (profile.framework === 'python' && profile.install_command) return ensurePythonDeps(sourcePath);
  if (!pkg) return { ok: true, reused: true };
  if (!['vite-frontend', 'nodejs', 'unknown'].includes(profile.runtime_id)) return { ok: true, reused: true };

  const includeDev = needsDevDeps(profile, pkg);
  const total = Object.keys(pkg.dependencies || {}).length + (includeDev ? Object.keys(pkg.devDependencies || {}).length : 0);
  if (!total) return { ok: true, reused: true };

  const missing = await findMissingDeps(sourcePath, pkg, includeDev);
  if (!missing.length) return { ok: true, reused: true };

  const hasLock = await exists(path.join(sourcePath, 'package-lock.json'));
  const flags = ['--no-audit', '--no-fund', '--loglevel=error', includeDev ? '--include=dev' : '--omit=dev'];
  const attempts = hasLock ? [['ci', ...flags], ['install', ...flags]] : [['install', ...flags]];
  let last = null;
  for (const args of attempts) {
    last = await runInstaller('npm', args, sourcePath);
    if (last.ok) {
      const still = await findMissingDeps(sourcePath, pkg, includeDev);
      if (!still.length) return { ok: true, reused: false };
      last = { ok: false, code: 'INSTALL_FAILED', error: `Libraries still missing after install: ${still.slice(0, 5).join(', ')}` };
    }
    if (last.code === 'INSTALL_TIMEOUT') break;
  }
  return { ok: false, code: last?.code || 'INSTALL_FAILED', error: last?.error || 'Install failed.' };
}

async function ensurePythonDeps(sourcePath) {
  const venvPy = path.join(sourcePath, '.venv', 'bin', 'python');
  if (!(await exists(venvPy))) {
    const py = commandExists('python3') ? 'python3' : 'python';
    const mk = await runInstaller(py, ['-m', 'venv', '.venv'], sourcePath);
    if (!mk.ok) return mk;
    const pip = await runInstaller(venvPy, ['-m', 'pip', 'install', '--disable-pip-version-check', '-q', '-r', 'requirements.txt'], sourcePath);
    if (!pip.ok) return pip;
  }
  return { ok: true, python: venvPy };
}

function runInstaller(bin, args, cwd) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    let timer = null;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    let child;
    try {
      child = spawn(bin, args, { cwd, env: safeEnv({}), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (err) {
      return resolve({ ok: false, code: 'TOOLCHAIN_MISSING', error: String(err?.message || err) });
    }
    timer = setTimeout(() => {
      killProcessTree(child);
      finish({ ok: false, code: 'INSTALL_TIMEOUT', error: `Install took longer than ${Math.round(INSTALL_TIMEOUT_MS / 1000)}s.` });
    }, INSTALL_TIMEOUT_MS);
    child.stdout?.on('data', (c) => { out = (out + c).slice(-2000); });
    child.stderr?.on('data', (c) => { out = (out + c).slice(-2000); });
    child.on('error', (err) => finish({ ok: false, code: err.code === 'ENOENT' ? 'TOOLCHAIN_MISSING' : 'INSTALL_FAILED', error: String(err.message).slice(0, 400) }));
    child.on('close', (code) => {
      if (code === 0) finish({ ok: true });
      else finish({ ok: false, code: 'INSTALL_FAILED', error: `${bin} ${args[0]} exited ${code}: ${out.slice(-500)}` });
    });
  });
}

// ---------------------------------------------------------------------------
// Launching
// ---------------------------------------------------------------------------

export function buildLaunchArgv(profile, pkg, port, deps = {}) {
  const scripts = pkg?.scripts || {};
  const id = profile.runtime_id;
  if (id === 'vite-frontend') {
    if (scripts.dev) return ['npm', 'run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'];
    return ['npx', '--no-install', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'];
  }
  if (id === 'nodejs' || id === 'unknown') {
    if (scripts.start) return ['npm', 'start', '--silent'];
    const cmd = String(profile.startup_command || '').trim();
    return cmd ? cmd.split(/\s+/) : null;
  }
  const cmd = String(profile.startup_command || '').replace(/\{PORT\}/g, String(port)).trim();
  if (!cmd) return null;
  const argv = cmd.split(/\s+/);
  if (deps.python && /^python3?$/.test(argv[0])) argv[0] = deps.python;
  return argv;
}

function spawnProcess(sourcePath, argv, port, state) {
  const dataDir = path.join(sourcePath, 'data');
  try { fssync.mkdirSync(dataDir, { recursive: true }); } catch { /* */ }
  const env = safeEnv({
    PORT: String(port),
    HOST: '127.0.0.1',
    BIND: '127.0.0.1',
    DATA_DIR: process.env.PREVIEW_DATA_DIR || dataDir,
    NODE_ENV: process.env.NODE_ENV === 'production' ? 'development' : (process.env.NODE_ENV || 'development'),
    PREVIEW_ONLINE: process.env.PREVIEW_ONLINE || 'true',
    BROWSER: 'none',
    CI: '1',
  });
  const [bin, ...args] = argv;
  const child = spawn(bin, args, { cwd: sourcePath, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', (c) => { state.stdout = clip(`${state.stdout}${String(c || '')}`); });
  child.stderr?.on('data', (c) => { state.stderr = clip(`${state.stderr}${String(c || '')}`); });
  child.on('error', (err) => { state.spawnError = err; });
  child.on('exit', (code, signal) => {
    if (state.stopping) return;
    state.exit = { code, signal, at: Date.now() };
    unregisterPreviewSession(state.slug);
  });
  child.unref();
  return child;
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function killProcessTree(child) {
  if (!child || !child.pid) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* */ } }
  setTimeout(() => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* */ } }
  }, 2500).unref?.();
}

function safeEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of DENIED_ENV) delete env[k];
  for (const k of Object.keys(env)) {
    if (/_(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)$/i.test(k) || /^(AWS_|AZURE_|GCP_)/i.test(k)) delete env[k];
  }
  return { ...env, ...extra };
}

/**
 * Ports an app printed as "where I listen", e.g. "Listening on http://localhost:3000".
 * Only lines that talk about listening/serving count, so "database port 5432" is ignored.
 */
export function portsFromLogs(text) {
  const out = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!/(listen|running|started|serving|available|local:|ready on|server)/i.test(line)) continue;
    for (const m of line.matchAll(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|port|PORT)[\s:=]*(\d{2,5})\b/g)) {
      const n = Number(m[1]);
      if (n >= 80 && n < 65536) out.add(n);
    }
  }
  return [...out];
}

/** Ports that must never be mistaken for this preview (Builder itself + other previews). */
function foreignPorts(ownSlug) {
  const set = new Set([Number(process.env.PORT || 8080)]);
  for (const [k, st] of processes) {
    if (k === ownSlug) continue;
    for (const p of st.ownedPorts || []) set.add(p);
  }
  return set;
}

async function waitForReady(state, port, timeoutSec) {
  const deadline = Date.now() + Math.max(5, Number(timeoutSec || 20)) * 1000;
  let lastProbe = 'The app did not answer yet.';
  while (Date.now() < deadline) {
    if (state.spawnError) {
      const missing = state.spawnError.code === 'ENOENT';
      return { ok: false, code: missing ? 'TOOLCHAIN_MISSING' : 'PROCESS_EXITED', error: String(state.spawnError.message).slice(0, 300) };
    }
    const logs = `${state.stderr}\n${state.stdout}`;
    if (state.exit) {
      const errLine = (logs.match(/^.*\b(?:Error|error)\b.*$/m) || [''])[0].trim().slice(0, 300);
      const tail = errLine || clip(logs, 400).trim();
      const conflict = /EADDRINUSE|address already in use/i.test(logs);
      const classified = classifyFailure(conflict ? 'PORT_CONFLICT' : 'PROCESS_EXITED', logs);
      return { ok: false, code: classified.code, error: `The app stopped with exit code ${state.exit.code}. ${tail}`.trim() };
    }
    if (/EADDRINUSE|address already in use/i.test(logs)) {
      return { ok: false, code: 'PORT_CONFLICT', error: 'Port already in use.' };
    }
    const foreign = foreignPorts(state.slug);
    const candidates = [port, ...portsFromLogs(logs).filter((p) => p !== port && !foreign.has(p))];
    for (const p of candidates) {
      const r = await probeHttp(p, ['/', '/health', '/__preview_health'], 1200);
      if (r.ok) return { ok: true, port: p, status: r.status };
      lastProbe = r.error || lastProbe;
    }
    await sleep(250);
  }
  return { ok: false, code: 'STARTUP_TIMEOUT', error: `${lastProbe} (waited ${timeoutSec}s)` };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function httpGet(url, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs, headers: { accept: 'text/html,*/*' } }, (res) => {
      res.resume();
      resolve({ status: res.statusCode || 0 });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', (err) => reject(err));
  });
}

/** Any HTTP answer below 500 on one of the probe paths counts as "alive". */
export async function probeHttp(port, paths = ['/'], timeoutMs = 1500) {
  let last = 'No answer.';
  for (const p of paths) {
    try {
      const r = await httpGet(`http://127.0.0.1:${port}${p}`, timeoutMs);
      if (r.status && r.status < 500) return { ok: true, status: r.status, path: p };
      last = `HTTP ${r.status} on ${p}`;
    } catch (err) {
      const code = err?.code || err?.cause?.code;
      last = code === 'ECONNREFUSED' ? 'Port is not open yet.' : String(err.message || err);
    }
  }
  return { ok: false, error: last };
}

export async function waitForHttp(port, timeoutSec) {
  const deadline = Date.now() + Math.max(3, Number(timeoutSec || 15)) * 1000;
  let last = 'Preview did not respond.';
  while (Date.now() < deadline) {
    const r = await probeHttp(port, ['/health', '/', '/index.html'], 1500);
    if (r.ok) return { ok: true };
    last = r.error;
    await sleep(200);
  }
  return { ok: false, error: last };
}

// ---------------------------------------------------------------------------
// Static server
// ---------------------------------------------------------------------------

export function createStaticServer(rootDir, slugName) {
  const root = path.resolve(rootDir);
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname === '/__preview_health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, slug: slugName }));
        return;
      }
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      const filePath = path.resolve(root, `.${rel}`);
      if (filePath !== root && !filePath.startsWith(root + path.sep)) {
        res.writeHead(403); res.end('Forbidden'); return;
      }
      let data = await fs.readFile(filePath).catch(() => null);
      let servedPath = filePath;
      if (!data) {
        // SPA fallback ONLY for page navigations — a missing .js/.css/.png must stay a real 404
        const wantsPage = !path.extname(rel) && /text\/html|\*\/\*/.test(String(req.headers.accept || '*/*'));
        const index = wantsPage ? await fs.readFile(path.join(root, 'index.html')).catch(() => null) : null;
        if (!index) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
        data = index; servedPath = path.join(root, 'index.html');
      }
      const type = MIME[path.extname(servedPath).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Length': data.length });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch (err) {
      res.writeHead(500); res.end(String(err?.message || err));
    }
  });
}

function createHybridGatewayServer(rootDir, backendPort, slugName) {
  const root = path.resolve(rootDir);
  const proxyToBackend = (req, res) => {
    const up = http.request({
      hostname: '127.0.0.1',
      port: backendPort,
      path: req.url || '/',
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${backendPort}` },
    }, (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res);
    });
    up.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Backend unreachable: ${err?.message || err}` }));
      }
    });
    req.pipe(up);
  };

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const p = url.pathname;
      if (p === '/__preview_health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, slug: slugName, gateway: true, backendPort }));
        return;
      }
      if (
        p === '/health'
        || p === '/api'
        || p.startsWith('/api/')
        || p.startsWith('/auth/')
        || p.startsWith('/graphql')
        || p.startsWith('/socket.io')
        || (req.method !== 'GET' && req.method !== 'HEAD')
      ) {
        return proxyToBackend(req, res);
      }
      let rel = decodeURIComponent(p);
      if (rel.endsWith('/')) rel += 'index.html';
      const filePath = path.resolve(root, `.${rel}`);
      if (filePath !== root && !filePath.startsWith(root + path.sep)) {
        res.writeHead(403); res.end('Forbidden'); return;
      }
      let data = await fs.readFile(filePath).catch(() => null);
      let servedPath = filePath;
      if (!data) {
        const wantsPage = !path.extname(rel) && /text\/html|\*\/\*/.test(String(req.headers.accept || '*/*'));
        const index = wantsPage ? await fs.readFile(path.join(root, 'index.html')).catch(() => null) : null;
        if (!index) return proxyToBackend(req, res);
        data = index; servedPath = path.join(root, 'index.html');
      }
      const type = MIME[path.extname(servedPath).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Length': data.length });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch (err) {
      if (!res.headersSent) { res.writeHead(500); res.end(String(err?.message || err)); }
    }
  });
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}

export async function resolvePublicDir(sourcePath) {
  const candidates = ['', 'public', 'dist', 'build', 'www', 'static'];
  for (const c of candidates) {
    const dir = path.join(sourcePath, c);
    if (await exists(path.join(dir, 'index.html'))) return c ? dir : sourcePath;
  }
  return null;
}

async function checkInternet() {
  const url = 'https://example.com/';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, { method: 'HEAD', signal: controller.signal, redirect: 'manual' });
    return { ok: response.status > 0, url, status: response.status };
  } catch (err) {
    return { ok: false, url, error: String(err?.message || err).slice(0, 240) };
  } finally {
    clearTimeout(timer);
  }
}

function slug(value) {
  return String(value || 'app').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 50) || 'app';
}
function clip(value, n = 12000) {
  return String(value || '').slice(-n);
}

export default NativePreview;
