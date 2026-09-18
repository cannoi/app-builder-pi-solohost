import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runPlaywrightE2E } from '../testing/playwright.js';

const sleep = promisify(setTimeout);
const execFileP = promisify(execFile);
const processes = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

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
    // Fix: a generated app with its own start command must own the port itself.
    // The old code always bound a decoy static server to `port` first and then
    // spawned the real app on the SAME port, so the real app silently failed to
    // bind (EADDRINUSE) while the decoy answered /health as if nothing were wrong.
    // Only fall back to the built-in static server for pure static sites that have
    // no server process of their own.
    const hasAppProcess = Boolean(pkg?.scripts?.start || pkg?.main);

    let server = null;
    let publicDir = null;
    let child = null;

    if (hasAppProcess) {
      // Fix: `Run` used to spawn the app straight away, before any `npm install`
      // step. A freshly generated project has no node_modules yet, so the child
      // process crashed immediately and the health check just saw a closed port
      // (surfaced as a generic "fetch failed"). Install once, only when needed.
      const deps = await ensureDependencies(sourcePath, pkg);
      if (deps.error) {
        return { status: 'failed', runtime: 'native-preview', health: false, error: `Dependency install failed: ${deps.error}` };
      }
      child = await spawnApp(sourcePath, port, pkg).catch(() => null);
    } else {
      publicDir = await resolvePublicDir(sourcePath);
      if (!publicDir) {
        return { status: 'failed', runtime: 'native-preview', health: false, error: 'No UI files were found. Tap Build first so the app has an index page.' };
      }
      server = createStaticServer(publicDir, safe);
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
    }

    const state = { server, child, port, publicDir, startedAt: Date.now(), stdout: '', stderr: '' };
    processes.set(safe, state);

    const health = await waitForHttp(port, Math.min(Number(timeout) || 30, 45));
    if (!health.ok) {
      await this.stop({ projectSlug: safe });
      return {
        status: 'failed', runtime: 'native-preview', hostPort: port, url: `http://127.0.0.1:${port}`,
        duration: Math.round((Date.now() - started) / 1000), health: false,
        error: health.error || 'The preview server did not start.',
      };
    }

    const localUrl = `http://127.0.0.1:${port}`;
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
    return {
      status: 'passed',
      runtime: 'native-preview',
      engine: 'native-preview',
      container: null,
      containerIp: null,
      hostPort: port,
      url: localUrl,
      duration: Math.round((Date.now() - started) / 1000),
      health: true,
      logs: clip(`${state.stdout}\n${state.stderr}`),
      e2e,
      previewPath: `/preview/${encodeURIComponent(safe)}/`,
      keptRunning: Boolean(keepRunning),
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

function createStaticServer(root, slugName) {
  return http.createServer((req, res) => {
    const raw = decodeURIComponent((req.url || '/').split('?')[0] || '/');
    if (raw === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', app: slugName, preview: true }));
      return;
    }
    let rel = raw === '/' ? '/index.html' : raw;
    const file = path.normalize(path.join(root, rel));
    if (!file.startsWith(root)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    fssync.readFile(file, (err, data) => {
      if (err) {
        const index = path.join(root, 'index.html');
        return fssync.readFile(index, (e2, html) => {
          if (e2) {
            res.writeHead(404);
            res.end('Not found');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
        });
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
  const file = pkg.scripts?.start ? (process.platform === 'win32' ? 'npm.cmd' : 'npm') : 'node';
  const args = pkg.scripts?.start ? ['start'] : [String(pkg.main)];
  const child = spawn(file, args, {
    cwd: sourcePath,
    env: {
      ...process.env,
      PORT: String(port),
      BIND: '127.0.0.1',
      HOST: '127.0.0.1',
      NODE_ENV: 'test',
    },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child;
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

async function waitForHttp(port, timeoutSec) {
  const deadline = Date.now() + Math.max(3, Number(timeoutSec || 15)) * 1000;
  let last = 'Preview did not respond.';
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return { ok: true };
      last = `HTTP ${r.status}`;
    } catch (err) {
      last = String(err.message || err);
    }
    // Fallback: not every generated app implements /health ("when practical" per the
    // build prompt). If the root path responds at all, treat the app as up rather
    // than timing out and reporting a false "did not start" error.
    try {
      const r2 = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
      if (r2.status < 500) return { ok: true };
    } catch {}
    await sleep(200);
  }
  return { ok: false, error: last };
}

function slug(value) { return String(value || 'app').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 50) || 'app'; }
function clip(value, n = 12000) { return String(value || '').slice(-n); }
