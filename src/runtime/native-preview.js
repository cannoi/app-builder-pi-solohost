import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { runPlaywrightE2E } from '../testing/playwright.js';

const sleep = promisify(setTimeout);
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

    const prepared = await this.prepare(sourcePath, timeout);
    if (!prepared.ok) return { status: 'failed', runtime: 'native-preview', error: prepared.error };

    const port = await freePort();
    const workDir = await fs.mkdtemp(path.join('/tmp', `paf-preview-${safe}-`));
    await copySource(sourcePath, workDir);
    const env = {
      PATH: process.env.PATH || '',
      HOME: workDir,
      NODE_ENV: 'test',
      CI: '1',
      PORT: String(port),
      BIND: '127.0.0.1',
      HOST: '127.0.0.1',
      npm_config_update_notifier: 'false',
      npm_config_fund: 'false',
      npm_config_audit: 'false',
    };

    const command = await startCommand(workDir);
    if (!command) {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
      return { status: 'failed', runtime: 'native-preview', error: 'No supported app start command was found.' };
    }

    const child = spawn(command.file, command.args, {
      cwd: workDir,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const key = safe;
    const state = { child, workDir, port, startedAt: Date.now(), stdout: '', stderr: '' };
    child.stdout?.on('data', (b) => { state.stdout = clip(state.stdout + b.toString(), 12000); });
    child.stderr?.on('data', (b) => { state.stderr = clip(state.stderr + b.toString(), 12000); });
    child.on('exit', (code, signal) => { state.exit = { code, signal }; });
    child.on('error', (err) => { state.spawnError = String(err.message || err); });
    processes.set(key, state);

    const health = await waitForHttp(port, timeout);
    if (!health.ok) {
      const logs = clip(`${state.stdout}\n${state.stderr}`);
      await this.stop({ projectSlug: safe });
      return {
        status: 'failed', runtime: 'native-preview', hostPort: port, url: `http://127.0.0.1:${port}`,
        duration: Math.round((Date.now() - started) / 1000), health: false, logs,
        error: health.error || 'The app did not start before the preview timeout.',
      };
    }

    const localUrl = `http://127.0.0.1:${port}`;
    const artifactDir = path.join(path.dirname(sourcePath), 'artifacts');
    await fs.mkdir(artifactDir, { recursive: true });
    const e2e = await runPlaywrightE2E({
      uiUrl: localUrl,
      screenshotPath: path.join(artifactDir, `${safe}-preview.png`),
      timeoutMs: Math.min(Math.max(Number(timeout) * 1000, 30000), 60000),
      browserFactory: this.browserFactory,
    });

    if (e2e.status !== 'success') {
      const logs = clip(`${state.stdout}\n${state.stderr}`);
      await this.stop({ projectSlug: safe });
      return {
        status: 'failed', runtime: 'native-preview', hostPort: port, url: localUrl,
        duration: Math.round((Date.now() - started) / 1000), health: true, logs, e2e,
        error: e2e.error || 'Preview opened but the browser check failed.',
      };
    }

    const result = {
      status: 'passed', runtime: 'native-preview', engine: 'native-process',
      container: null, containerIp: null, hostPort: port, url: localUrl,
      duration: Math.round((Date.now() - started) / 1000), health: true,
      logs: clip(`${state.stdout}\n${state.stderr}`), e2e,
      previewPath: `/preview/${encodeURIComponent(safe)}/`,
      keptRunning: Boolean(keepRunning),
    };
    if (!keepRunning) await this.stop({ projectSlug: safe });
    return result;
  }

  async prepare(sourcePath, timeout) {
    const pkgPath = path.join(sourcePath, 'package.json');
    try {
      const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
      if (!pkg.scripts?.start && !pkg.main) {
        if (await fs.access(path.join(sourcePath, 'public', 'index.html')).then(() => true).catch(() => false)) return { ok: true };
        return { ok: false, error: 'package.json has no start script and no supported static entry was found.' };
      }
      const nodeModules = path.join(sourcePath, 'node_modules');
      if (!(await fs.access(nodeModules).then(() => true).catch(() => false))) {
        const { execFile } = await import('node:child_process');
        const exec = promisify(execFile);
        try {
          await exec('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: sourcePath, timeout: Math.min(Number(timeout || 180) * 1000, 120000), maxBuffer: 4 * 1024 * 1024 });
        } catch (err) {
          return { ok: false, error: `Dependencies could not be installed safely: ${clip(String(err.stderr || err.stdout || err.message))}` };
        }
      }
      return { ok: true };
    } catch {
      if (await fs.access(path.join(sourcePath, 'public', 'index.html')).then(() => true).catch(() => false)) return { ok: true };
      return { ok: false, error: 'No supported JavaScript app entry was found.' };
    }
  }

  async stop({ projectSlug }) {
    const key = slug(projectSlug);
    const state = processes.get(key);
    if (!state) return { status: 'stopped', runtime: 'native-preview', container: null };
    processes.delete(key);
    try { process.kill(-state.child.pid, 'SIGTERM'); } catch { try { state.child.kill('SIGTERM'); } catch {} }
    await sleep(500);
    try { process.kill(-state.child.pid, 'SIGKILL'); } catch {}
    await fs.rm(state.workDir, { recursive: true, force: true }).catch(() => {});
    return { status: 'stopped', runtime: 'native-preview', projectSlug: key };
  }

  async status({ projectSlug }) {
    const state = processes.get(slug(projectSlug));
    if (!state || state.child.exit) return { status: 'stopped', runtime: 'native-preview', hostPort: null, url: null };
    return { status: 'running', runtime: 'native-preview', hostPort: state.port, url: `http://127.0.0.1:${state.port}`, previewPath: `/preview/${encodeURIComponent(slug(projectSlug))}/` };
  }

  async command() {
    return { status: 'blocked', runtime: 'native-preview', error: 'Raw shell commands are disabled. Use Build, Run, Check, or Improve.' };
  }
}

async function startCommand(cwd) {
  const pkg = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8').catch(() => '{}'));
  if (pkg.scripts?.start) return { file: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: ['start'] };
  if (pkg.main) return { file: 'node', args: [String(pkg.main)] };
  const html = path.join(cwd, 'public', 'index.html');
  if (await fs.access(html).then(() => true).catch(() => false)) {
    const script = `const http=require('http'),fs=require('fs'),path=require('path');const root=${JSON.stringify(path.join(cwd, 'public'))};const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'};http.createServer((q,s)=>{let p=decodeURIComponent(q.url.split('?')[0]);if(p==='/'||p==='')p='/index.html';const f=path.join(root,p);if(!f.startsWith(root))return s.writeHead(403).end();fs.readFile(f,(e,b)=>{if(e)return s.writeHead(404).end('Not found');s.writeHead(200,{'Content-Type':mime[path.extname(f)]||'application/octet-stream'});s.end(b);});}).listen(Number(process.env.PORT||8080),'127.0.0.1');`;
    return { file: 'node', args: ['-e', script] };
  }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function copySource(sourcePath, destination) {
  await fs.cp(sourcePath, destination, { recursive: true, force: true, filter: (src) => !/[/\\](node_modules|\.git|artifacts|data|workspace|projects)[/\\]?/.test(src) });
  const srcModules = path.join(sourcePath, 'node_modules');
  if (await fs.access(srcModules).then(() => true).catch(() => false)) await fs.cp(srcModules, path.join(destination, 'node_modules'), { recursive: true, force: true });
}

async function waitForHttp(port, timeoutSec) {
  const deadline = Date.now() + Math.min(Number(timeoutSec || 180), 600) * 1000;
  let last = 'Preview did not respond.';
  while (Date.now() < deadline) {
    for (const p of ['/health', '/']) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(2500) });
        if (r.ok || r.status < 500) return { ok: true, url: `http://127.0.0.1:${port}${p}` };
        last = `HTTP ${r.status} at ${p}`;
      } catch (err) { last = String(err.message || err); }
    }
    await sleep(700);
  }
  return { ok: false, error: last };
}

function slug(value) { return String(value || 'app').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 50) || 'app'; }
function clip(value, n = 12000) { return String(value || '').slice(-n); }
