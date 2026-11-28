/**
 * Runtime verification (v1.10.0, M2): boot → process health → HTTP /health → route probe.
 *
 * The app ALWAYS runs from a temporary copy of the source (node_modules is symlinked, never copied), so
 * an app that writes files at startup can never mutate the user's project. Processes start through the
 * controlled executor (startControlled) on an ephemeral port with PORT set, and are always stopped
 * (success, failure, timeout, cancel) — see stopApp() and the finally blocks in the pipeline.
 */
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { STATUS } from '../validation/status.js';
import { startControlled } from '../executor/exec.js';
import { classifyFailure } from '../../testing/classify-failure.js';
import { redactText } from '../redact.js';

const SKIP = new Set(['node_modules', '.git', 'snapshots', 'artifacts', 'logs', 'data', 'coverage']);
const DESTRUCTIVE_PATH = /(delete|remove|destroy|reset|logout|signout|purge|drop|wipe|shutdown|kill|pay|checkout|charge|write-test|cpu-test|parallel-test|internet|web-view)/i;

export function scaledTimeout(baseMs) {
  const scale = Number(process.env.ENGINEERING_TIMEOUT_SCALE || 0) || ((/arm/i.test(os.arch()) || (os.cpus()?.length || 4) <= 4) ? 2 : 1);
  return Math.round(baseMs * scale);
}

export async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function copyTree(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  for (const e of await fs.readdir(src, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const from = path.join(src, e.name);
    const to = path.join(dest, e.name);
    if (e.isDirectory()) await copyTree(from, to);
    else if (e.isFile()) await fs.copyFile(from, to);
  }
}

/** Make an isolated runnable copy. node_modules is linked read-through (not copied). */
export async function prepareRunCopy(sourceDir) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-run-'));
  await copyTree(sourceDir, dir);
  const nm = path.join(sourceDir, 'node_modules');
  if (await fs.stat(nm).then((s) => s.isDirectory()).catch(() => false)) {
    await fs.symlink(nm, path.join(dir, 'node_modules'), 'dir').catch(() => {});
  }
  return { dir, async cleanup() { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); } };
}

async function readPkg(dir) {
  try { return JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8')); } catch { return null; }
}

/** Decide how to start the app. Returns { name, args } or { unavailable: reason }. */
export async function resolveStartCommand(dir, fingerprint = {}) {
  const pkg = await readPkg(dir);
  const start = String(pkg?.scripts?.start || '').trim();
  const direct = /^node\s+(\.\/)?([\w./-]+\.(?:c|m)?js)$/.exec(start);
  if (direct) return { name: 'node.start', args: [direct[2]] };
  if (start) return { name: 'npm.start', args: [] };
  for (const f of [fingerprint.entrypoint, 'src/server.js', 'server.js', 'index.js', 'app.js', 'src/index.js'].filter((x) => x && !String(x).startsWith('script:'))) {
    if (await fs.access(path.join(dir, f)).then(() => true).catch(() => false)) return { name: 'node.start', args: [f] };
  }
  return { unavailable: 'No start script and no server entry file (server.js / index.js / app.js).' };
}

export async function depsInstalled(dir) {
  const pkg = await readPkg(dir);
  const deps = Object.keys(pkg?.dependencies || {});
  if (!deps.length) return { ok: true, needed: false };
  const nm = path.join(dir, 'node_modules');
  for (const d of deps) {
    if (!(await fs.access(path.join(nm, d)).then(() => true).catch(() => false))) return { ok: false, needed: true, missing: d };
  }
  return { ok: true, needed: true };
}

async function httpGet(url, { timeoutMs = 4000, method = 'GET' } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  const started = Date.now();
  try {
    const r = await fetch(url, { method, redirect: 'manual', signal: ac.signal, headers: { 'user-agent': 'AppBuilder-Verify/1.10' } });
    const body = await r.text().catch(() => '');
    return { ok: true, status: r.status, headers: Object.fromEntries(r.headers.entries()), body: body.slice(0, 20000), ms: Date.now() - started };
  } catch (err) {
    return { ok: false, error: String(err.cause?.code || err.message || err), ms: Date.now() - started };
  } finally { clearTimeout(t); }
}

/**
 * Start the app and wait until it answers HTTP (any status) or exits.
 * Returns { status, handle?, baseUrl?, port, message, logs, classification }.
 */
export async function startApp(sourceDir, { fingerprint = {}, timeoutMs = scaledTimeout(20_000), extraEnv = {}, signal } = {}) {
  const deps = await depsInstalled(sourceDir);
  if (!deps.ok) {
    return { status: STATUS.NOT_TESTED, message: `Dependencies are not installed (missing ${deps.missing}); runtime check skipped. Run tests/install first.`, reason: 'DEPS_NOT_INSTALLED' };
  }
  const copy = await prepareRunCopy(sourceDir);
  const cmd = await resolveStartCommand(copy.dir, fingerprint);
  if (cmd.unavailable) { await copy.cleanup(); return { status: STATUS.NOT_AVAILABLE, message: cmd.unavailable }; }
  const port = await freePort();
  const started = await startControlled(cmd.name, cmd.args, { projectRoot: copy.dir, port, extraEnv, signal });
  if (!started.ok) { await copy.cleanup(); return { status: started.policyRejected ? STATUS.FAIL : STATUS.NOT_AVAILABLE, message: started.error, command: cmd }; }
  const handle = started.handle;
  const baseUrl = `http://127.0.0.1:${port}`;
  const until = Date.now() + timeoutMs;
  let answered = null;
  while (Date.now() < until) {
    if (handle.exited) break;
    if (signal?.aborted) break;
    const r = await httpGet(`${baseUrl}/`, { timeoutMs: 1500 });
    if (r.ok) { answered = r; break; }
    await new Promise((res) => setTimeout(res, 250));
  }
  const app = {
    handle, baseUrl, port, command: cmd, copyDir: copy.dir,
    async stop() { const s = await handle.stop(); await copy.cleanup(); return s; },
  };
  if (answered) return { status: STATUS.PASS, app, baseUrl, port, message: `App answered on ${baseUrl} (${cmd.name} ${cmd.args.join(' ')})`.trim() };
  const logs = handle.logs();
  const tail = `${logs.stderrTail}\n${logs.stdoutTail}`.trim().slice(-3000);
  await app.stop();
  if (handle.exited) {
    const cls = classifyFailure(tail || `exit ${handle.exited.code}`);
    const fileLine = /\/(?:paf-run-[^/]+)\/([^:\s]+):(\d+)/.exec(tail);
    return {
      status: /^ENV_/.test(cls.class) ? STATUS.NOT_TESTED : STATUS.FAIL,
      message: `The app exited during startup (code ${handle.exited.code}). ${tail.split('\n').filter(Boolean).slice(-3).join(' | ')}`.slice(0, 600),
      logs: redactText(tail),
      classification: cls,
      file: fileLine?.[1] || null,
      line: fileLine ? Number(fileLine[2]) : null,
      port,
    };
  }
  // Still running but never answered on PORT → most likely ignores PORT or binds elsewhere.
  return {
    status: STATUS.FAIL,
    message: `The app process started but did not answer HTTP on PORT=${port} within ${Math.round(timeoutMs / 1000)} s. It may ignore process.env.PORT (port mismatch) or bind to another interface.`,
    logs: redactText(tail),
    classification: { class: 'PORT_MISMATCH', aiRepair: true },
    port,
    reason: 'NO_HTTP_ON_PORT',
  };
}

const HEALTH_PATHS = ['/health', '/api/health', '/healthz'];

export async function probeHealth(baseUrl, { routes = [] } = {}) {
  const declared = routes.filter((r) => /^\/(api\/)?(health|healthz)$/.test(r));
  const candidates = [...new Set([...declared, ...HEALTH_PATHS])];
  const tried = [];
  for (const p of candidates) {
    const r = await httpGet(baseUrl + p);
    tried.push({ path: p, status: r.status || null, error: r.error || null });
    if (r.ok && r.status >= 200 && r.status < 300) {
      return { status: STATUS.PASS, message: `GET ${p} → ${r.status}`, evidence: { path: p, httpStatus: r.status, ms: r.ms } };
    }
    if (r.ok && r.status >= 500) return { status: STATUS.FAIL, message: `GET ${p} → ${r.status}`, evidence: { path: p, httpStatus: r.status, body: r.body.slice(0, 300) } };
  }
  if (!declared.length) return { status: STATUS.WARNING, message: 'No health endpoint (/health) answered 2xx and none is declared (MISSING_HEALTH_ENDPOINT).', evidence: { tried }, finding: 'MISSING_HEALTH_ENDPOINT' };
  return { status: STATUS.FAIL, message: `Declared health route did not answer 2xx: ${tried.map((t) => `${t.path}→${t.status || t.error}`).join(', ')}`, evidence: { tried } };
}

/**
 * Probe GET routes (server routes + client-referenced API/asset paths).
 * 5xx → FAIL; declared route 404 → FAIL; /api/* 2xx must be JSON; client asset must be 2xx.
 */
export async function probeRoutes(baseUrl, { serverRoutes = [], clientCalls = [], max = 14 } = {}) {
  const targets = [];
  const seen = new Set();
  const push = (p, source, extra = {}) => {
    if (!p || seen.has(p) || targets.length >= max) return;
    if (DESTRUCTIVE_PATH.test(p) || p.includes(':') || p.includes('*')) return;
    seen.add(p);
    targets.push({ path: p, source, ...extra });
  };
  for (const r of serverRoutes) if (r.kind === 'exact' && (r.method === 'GET' || r.method === 'ANY' || r.method === 'HEAD')) push(r.path, 'server', { method: r.method, file: r.file, line: r.line });
  for (const c of clientCalls) if (!c.dynamic && (c.method === 'GET') && (c.kind === 'api' || c.kind === 'asset')) push(c.path, `client:${c.kind}`, { file: c.file, line: c.line });
  const results = [];
  for (const t of targets) {
    const r = await httpGet(baseUrl + t.path);
    let verdict = STATUS.PASS;
    let note = '';
    if (!r.ok) { verdict = STATUS.FAIL; note = r.error; }
    else if (r.status >= 500) { verdict = STATUS.FAIL; note = `HTTP ${r.status}`; }
    else if (r.status === 404) { verdict = STATUS.FAIL; note = 'HTTP 404'; }
    else if (r.status === 405 || r.status === 400 || r.status === 401 || r.status === 403) {
      // a GET probe on a POST-only or protected route is not a defect by itself
      verdict = t.source.startsWith('client') && t.source.endsWith('asset') ? STATUS.FAIL : STATUS.PASS;
      note = `HTTP ${r.status} (not a GET route or protected)`;
    } else if (r.status >= 200 && r.status < 300 && /^\/api\//.test(t.path)) {
      const ct = String(r.headers['content-type'] || '');
      if (/json/i.test(ct) || /^\s*[[{]/.test(r.body)) {
        try { JSON.parse(r.body); } catch { verdict = STATUS.FAIL; note = 'response is not valid JSON'; }
      }
    }
    results.push({ ...t, httpStatus: r.status || null, verdict, note, ms: r.ms });
  }
  const failed = results.filter((r) => r.verdict === STATUS.FAIL);
  return {
    status: !targets.length ? STATUS.NOT_AVAILABLE : failed.length ? STATUS.FAIL : STATUS.PASS,
    message: !targets.length ? 'No GET routes to probe' : failed.length ? failed.slice(0, 4).map((f) => `GET ${f.path} → ${f.note}${f.file ? ` (${f.file}:${f.line})` : ''}`).join('; ') : `${results.length} route(s) answered correctly`,
    evidence: { results },
  };
}
