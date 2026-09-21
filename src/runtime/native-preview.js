import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runPlaywrightE2E } from '../testing/playwright.js';
import { PREVIEW_MIME as MIME } from '../preview-mime.js';
import { findProjectAsset } from '../preview.js';

const sleep = promisify(setTimeout);
const execFileP = promisify(execFile);
const processes = new Map();

export class NativePreview {
  constructor({ cfg, log, browserFactory = null } = {}) {
    this.cfg = cfg;
    this.log = log;
    this.browserFactory = browserFactory;
  }

  async run({ sourcePath, projectSlug, timeout = 180, keepRunning = true }) {
    const safe = slug(projectSlug);
    const started = Date.now();
    await this.stop({ projectSlug: safe }).catch(() => {});

    const port = await freePort();
    const pkg = await readPackageJson(sourcePath);
    // Preview must not depend on the generated process binding PORT.
    // Snake/Express apps often hardcode 8080 or crash on missing modules.
    // waitForHttp then reports "fetch failed". If index.html exists, Builder
    // owns the preview port and always answers /health.
    const publicDir = await resolvePublicDir(sourcePath);
    const hasAppProcess = Boolean(pkg?.scripts?.start || pkg?.main);

    let server = null;
    let child = null;
    let apiPort = null;

    if (publicDir) {
      server = createStaticServer(sourcePath, safe);
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
      if (hasAppProcess) {
        const deps = await ensureDependencies(sourcePath, pkg);
        if (!deps.error) {
          apiPort = await freePort();
          child = await spawnApp(sourcePath, apiPort, pkg).catch(() => null);
          const apiUp = await waitForHttp(apiPort, 15);
          if (!apiUp.ok) apiPort = null;
        }
      }
    } else if (hasAppProcess) {
      const deps = await ensureDependencies(sourcePath, pkg);
      if (deps.error) {
        return { status: 'failed', runtime: 'native-preview', health: false, error: `Dependency install failed: ${deps.error}` };
      }
      child = await spawnApp(sourcePath, port, pkg).catch(() => null);
    } else {
      // Fix: this native fallback can only run a Node process (package.json with
      // a start script) or serve static files (an index.html). A project that
      // has neither but DOES have a Dockerfile — installs system packages, runs
      // a non-Node service (Python, Go, supervisord-managed multi-process
      // images, VNC/browser containers, etc.) — can never work here no matter
      // how many times Build is re-run; the old generic "No UI files were
      // found. Tap Build first" message was actively misleading for exactly
      // that case. Give the real, actionable reason instead.
      const hasDockerfile = await fs.access(path.join(sourcePath, 'Dockerfile')).then(() => true).catch(() => false);
      const error = hasDockerfile
        ? 'This app has no package.json or index.html — it can only run as a real Docker container (it likely installs system packages or runs a non-Node service). Enable Container Sandbox (Podman) in Settings; the built-in safe preview only supports Node.js or static-file apps.'
        : 'No UI files were found. Tap Build first so the app has an index page.';
      return { status: 'failed', runtime: 'native-preview', health: false, error };
    }

    const state = { server, child, port, publicDir, startedAt: Date.now(), stdout: '', stderr: '' };
    processes.set(safe, state);

    const health = await waitForHttp(port, Math.min(Number(timeout) || 30, 45));
    if (!health.ok) {
      await this.stop({ projectSlug: safe });
      return {
        status: 'failed', runtime: 'native-preview', hostPort: port, url: `http://127.0.0.1:${port}`,
        duration: Math.round((Date.now() - started) / 1000), health: false,
        error: health.error || 'The preview server did not start. Check the app startup log and port binding.',
      };
    }

    const localUrl = `http://127.0.0.1:${port}`;
    const internet = await checkInternet();
    let e2e = { status: 'skipped', error: null };
    try {
      const artifactDir = path.join(path.dirname(sourcePath), 'artifacts');
      await fs.mkdir(artifactDir, { recursive: true });
      e2e = await runPlaywrightE2E({
        uiUrl: localUrl,
        screenshotPath: path.join(artifactDir, `${safe}-preview.png`),
        timeoutMs: 12000,
        browserFactory: this.browserFactory,
      });
    } catch (err) {
      e2e = { status: 'skipped', error: String(err.message || err).slice(0, 300) };
    }

    if (!keepRunning) await this.stop({ projectSlug: safe });
    const requireInternet = this.cfg?.preview?.requireInternet === true;
    const requireBrowserTest = this.cfg?.preview?.requireBrowserTest === true;
    const verified = (!requireInternet || internet.ok) && (!requireBrowserTest || e2e.status === 'passed');
    return {
      status: verified ? 'passed' : 'failed',
      runtime: 'native-preview',
      engine: 'native-preview',
      container: null,
      containerIp: null,
      hostPort: port,
      proxyHost: '127.0.0.1',
      proxyPort: port,
      apiHost: apiPort ? '127.0.0.1' : null,
      apiPort,
      url: localUrl,
      duration: Math.round((Date.now() - started) / 1000),
      health: true,
      internet: { enabled: true, ok: internet.ok, url: internet.url, error: internet.error || null },
      logs: clip(`${state.stdout}\n${state.stderr}`),
      e2e,
      previewPath: `/preview/${encodeURIComponent(safe)}/`,
      keptRunning: Boolean(keepRunning),
      verification: verified ? 'health + required checks passed' : 'preview requires health + configured Internet + browser-e2e checks',
      error: verified ? null : [requireInternet && !internet.ok ? `Preview Internet check failed: ${internet.error || 'outbound network unavailable'}.` : null, requireBrowserTest && e2e.status !== 'passed' ? `Browser E2E failed: ${e2e.error || 'browser test returned failed status'}. Page: ${e2e.ui_url || localUrl}.` : null].filter(Boolean).join(' '),
    };
  }

  async stop({ projectSlug }) {
    const key = slug(projectSlug);
    const state = processes.get(key);
    if (!state) return { status: 'stopped', runtime: 'native-preview', container: null };
    processes.delete(key);
    if (state.server) {
      await new Promise((resolve) => state.server.close(() => resolve())).catch(() => {});
    }
    if (state.child?.pid) {
      try { process.kill(-state.child.pid, 'SIGTERM'); } catch { try { state.child.kill('SIGTERM'); } catch {} }
    }
    return { status: 'stopped', runtime: 'native-preview', projectSlug: key };
  }

  async status({ projectSlug }) {
    const state = processes.get(slug(projectSlug));
    if (!state) return { status: 'stopped', runtime: 'native-preview', hostPort: null, url: null };
    return { status: 'running', runtime: 'native-preview', hostPort: state.port, url: `http://127.0.0.1:${state.port}`, previewPath: `/preview/${encodeURIComponent(slug(projectSlug))}/` };
  }

  async command() {
    return { status: 'blocked', runtime: 'native-preview', error: 'Raw shell commands are disabled. Use Build, Run, Check, or Improve.' };
  }
}

function createStaticServer(sourcePath, slugName) {
  return http.createServer((req, res) => {
    const raw = decodeURIComponent((req.url || '/').split('?')[0] || '/');
    if (raw === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', app: slugName, preview: true }));
      return;
    }
    const file = findProjectAsset(sourcePath, raw === '/' ? '/index.html' : raw);
    if (!file) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    fssync.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      res.end(data);
    });
  });
}

async function resolvePublicDir(sourcePath) {
  const candidates = [
    path.join(sourcePath, 'public'),
    path.join(sourcePath, 'dist'),
    path.join(sourcePath, 'www'),
    path.join(sourcePath, 'static'),
    path.join(sourcePath, 'htdocs'),
    path.join(sourcePath, 'app', 'public'),
    path.join(sourcePath, 'assets'),
    path.join(sourcePath, 'build'),
    path.join(sourcePath, 'out'),
    path.join(sourcePath, 'site'),
    path.join(sourcePath, 'web'),
    path.join(sourcePath, 'frontend'),
    path.join(sourcePath, 'client'),
    path.join(sourcePath, 'ui'),
    path.join(sourcePath, 'docs'),
    sourcePath,
  ];
  for (const dir of candidates) {
    if (await fs.access(path.join(dir, 'index.html')).then(() => true).catch(() => false)) return dir;
  }
  return null;
}

async function ensureDependencies(sourcePath, pkg) {
  const hasDeps = Boolean(pkg?.dependencies && Object.keys(pkg.dependencies).length);
  if (!hasDeps) return { installed: false };
  const modulesDir = path.join(sourcePath, 'node_modules');
  const already = await fs.access(modulesDir).then(() => true).catch(() => false);
  if (already) return { installed: false };
  try {
    await execFileP('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: sourcePath, timeout: 120000, maxBuffer: 4 * 1024 * 1024,
    });
    return { installed: true };
  } catch (err) {
    return { installed: false, error: String(err.stderr || err.stdout || err.message || err).slice(0, 2000) };
  }
}

async function readPackageJson(sourcePath) {
  try { return JSON.parse(await fs.readFile(path.join(sourcePath, 'package.json'), 'utf8')); } catch { return null; }
}

async function spawnApp(sourcePath, port, pkgIn = null) {
  const pkg = pkgIn || await readPackageJson(sourcePath);
  if (!pkg?.scripts?.start && !pkg?.main) return null;
  const start = String(pkg.scripts?.start || '');
  const fromStart = start.match(/\bnode\s+(\S+)/);
  const entry = pkg.main || fromStart?.[1] || null;
  const file = entry ? 'node' : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const args = entry ? [entry] : ['start'];
  const child = spawn(file, args, {
    cwd: sourcePath,
    env: {
      ...process.env,
      PORT: String(port),
      BIND: '127.0.0.1',
      HOST: '127.0.0.1',
      NODE_ENV: 'test',
      PREVIEW_ONLINE: process.env.PREVIEW_ONLINE || 'true',
    },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child;
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

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function httpGet(url, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve({ status: res.statusCode || 0 });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', (err) => reject(err));
  });
}

async function waitForHttp(port, timeoutSec) {
  const deadline = Date.now() + Math.max(3, Number(timeoutSec || 15)) * 1000;
  let last = 'Preview did not respond.';
  while (Date.now() < deadline) {
    for (const pathName of ['/health', '/']) {
      try {
        const r = await httpGet(`http://127.0.0.1:${port}${pathName}`);
        if (r.status && r.status < 500) return { ok: true };
        last = `HTTP ${r.status}`;
      } catch (err) {
        const code = err?.code || err?.cause?.code;
        last = code === 'ECONNREFUSED' ? 'Preview port is not open yet.' : String(err.message || err);
      }
    }
    await sleep(150);
  }
  return { ok: false, error: last };
}

function slug(value) { return String(value || 'app').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 50) || 'app'; }
function clip(value, n = 12000) { return String(value || '').slice(-n); }
