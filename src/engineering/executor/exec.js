/**
 * Controlled process executor (v1.10.0, D-02) — the ONLY place toolkit code spawns processes.
 *
 * - structured named commands (policy.js), no shell, no parent env (allowlist only)
 * - NODE_ENV=development for install/test/build (devDependencies install), production only for start
 * - FIFO queue with bounded wait instead of "executor busy" failures (one heavy job at a time)
 * - output redacted (provider keys, GitHub tokens, Feedback token/hub id) and kept as a TAIL ring buffer
 * - process-group cleanup in finally (SIGTERM → grace → SIGKILL), timeout + AbortSignal cancel
 * - classification through testing/classify-failure.js (ENV_* ⇒ NOT_TESTED, never an AI-repair trigger)
 * - every call appended to engineering-audit.jsonl (redacted, rotated at 1 MB, 3 files kept)
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgv, resolveNamedCommand, buildChildEnv } from './policy.js';
import { STATUS } from '../validation/status.js';
import { redactText } from '../redact.js';
import { classifyFailure } from '../../testing/classify-failure.js';

export const MAX_TAIL_BYTES = 64 * 1024;
const DEFAULT_QUEUE_WAIT_MS = Number(process.env.ENGINEERING_EXEC_QUEUE_MS || 120_000);
const KILL_GRACE_MS = 1500;

let cachedNodePermission = null;
export function supportsNodePermission() {
  if (cachedNodePermission !== null) return cachedNodePermission;
  try {
    execFileSync(process.execPath, ['--permission', `--allow-fs-read=${process.cwd()}`, '-e', '1'], {
      stdio: 'ignore',
      timeout: 3000,
    });
    cachedNodePermission = true;
  } catch {
    cachedNodePermission = false;
  }
  return cachedNodePermission;
}

function uniqueRealRoots(dirs = []) {
  const out = [];
  const seen = new Set();
  for (const d of dirs.filter(Boolean)) {
    const abs = path.resolve(d);
    if (!seen.has(abs)) { seen.add(abs); out.push(abs); }
    try {
      const real = fs.realpathSync(abs);
      if (real && !seen.has(real)) { seen.add(real); out.push(real); }
    } catch { /* missing */ }
  }
  return out;
}

export function buildNodePermissionArgs({ command, projectRoot, cwd, homeDir = null, writable = true, allowChildProcess = false } = {}) {
  if (process.env.ENGINEERING_NODE_PERMISSION === '0') return [];
  if (!['node.start', 'node.check'].includes(command)) return [];
  if (!supportsNodePermission()) return [];
  const nm = path.join(projectRoot, 'node_modules');
  const readRoots = uniqueRealRoots([projectRoot, cwd, homeDir, fs.existsSync(nm) ? nm : null]);
  const args = ['--permission', ...readRoots.map((r) => `--allow-fs-read=${r}`)];
  if (writable && command === 'node.start') {
    const writeRoots = uniqueRealRoots([projectRoot, cwd, homeDir]);
    args.push(...writeRoots.map((r) => `--allow-fs-write=${r}`));
  }
  if (allowChildProcess && command === 'node.start') {
    args.push('--allow-child-process');
  }
  return args;
}

// ---------------------------------------------------------------- FIFO queue
let running = false;
const waiters = [];

function acquire({ waitMs = DEFAULT_QUEUE_WAIT_MS, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('cancelled before start'), { code: 'CANCELLED' }));
    if (!running) { running = true; return resolve(release); }
    const entry = { resolve: null, reject: null, timer: null };
    const cleanup = () => {
      clearTimeout(entry.timer);
      const i = waiters.indexOf(entry);
      if (i >= 0) waiters.splice(i, 1);
      signal?.removeEventListener?.('abort', onAbort);
    };
    const onAbort = () => { cleanup(); reject(Object.assign(new Error('cancelled while queued'), { code: 'CANCELLED' })); };
    entry.resolve = () => { cleanup(); resolve(release); };
    entry.reject = reject;
    entry.timer = setTimeout(() => { cleanup(); reject(Object.assign(new Error(`executor queue wait exceeded ${waitMs} ms`), { code: 'QUEUE_TIMEOUT' })); }, waitMs);
    signal?.addEventListener?.('abort', onAbort, { once: true });
    waiters.push(entry);
  });
}

function release() {
  const next = waiters.shift();
  if (next) next.resolve();
  else running = false;
}

export function isExecutorBusy() { return running; }
export function executorQueueLength() { return waiters.length; }

// ---------------------------------------------------------------- tail buffer
export function createTail(max = MAX_TAIL_BYTES) {
  let chunks = [];
  let size = 0;
  let total = 0;
  return {
    push(buf) {
      const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf));
      total += b.length;
      chunks.push(b);
      size += b.length;
      while (size > max && chunks.length) {
        const over = size - max;
        if (chunks[0].length <= over) { size -= chunks[0].length; chunks.shift(); }
        else { chunks[0] = chunks[0].subarray(over); size -= over; }
      }
    },
    text() { return Buffer.concat(chunks).toString('utf8'); },
    get total() { return total; },
    get truncated() { return total > size; },
  };
}

// ---------------------------------------------------------------- audit log
function auditDir() {
  return process.env.ENGINEERING_AUDIT_DIR || (process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(os.tmpdir(), 'paf-engineering'));
}
export function auditFile() { return path.join(auditDir(), 'engineering-audit.jsonl'); }

export async function appendAudit(entry, { maxBytes = 1024 * 1024, keep = 3 } = {}) {
  try {
    const file = auditFile();
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const st = await fsp.stat(file).catch(() => null);
    if (st && st.size >= maxBytes) {
      for (let i = keep - 1; i >= 1; i -= 1) await fsp.rename(`${file}.${i}`, `${file}.${i + 1}`).catch(() => {});
      await fsp.rename(file, `${file}.1`).catch(() => {});
      await fsp.rm(`${file}.${keep + 1}`, { force: true }).catch(() => {});
    }
    await fsp.appendFile(file, `${redactText(JSON.stringify({ at: new Date().toISOString(), ...entry }))}\n`);
  } catch { /* auditing must never break a job */ }
}

// ---------------------------------------------------------------- process helpers
function groupAlive(pid) {
  if (!pid) return false;
  try { process.kill(-pid, 0); return true; } catch { return false; }
}

export async function killGroup(pid, graceMs = KILL_GRACE_MS) {
  if (!pid) return;
  try { process.kill(-pid, 'SIGTERM'); } catch { /* gone */ }
  const until = Date.now() + graceMs;
  while (Date.now() < until && groupAlive(pid)) await new Promise((r) => setTimeout(r, 50));
  if (groupAlive(pid)) { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }
}

function npmCacheDir(homeDir, network = false) {
  const base = process.env.ENGINEERING_NPM_CACHE
    || (network && process.env.DATA_DIR ? path.join(path.resolve(process.env.DATA_DIR), 'npm-cache') : path.join(homeDir || os.tmpdir(), 'npm-cache'));
  try { fs.mkdirSync(base, { recursive: true }); } catch { /* */ }
  return base;
}

function binaryFor(argv0) {
  return argv0 === 'node' ? process.execPath : argv0;
}

function finish({ name, argv, exitCode, signal, timedOut, cancelled, spawnError, durationMs, out, err }) {
  const stdoutTail = redactText(out.text());
  const stderrTail = redactText(err.text());
  let status;
  let classification = null;
  if (spawnError) {
    status = /ENOENT/.test(spawnError) ? STATUS.NOT_AVAILABLE : STATUS.FAIL;
    classification = { class: status === STATUS.NOT_AVAILABLE ? 'ENV_MISSING_BINARY' : 'UNKNOWN', aiRepair: false };
  } else if (timedOut) {
    status = STATUS.NOT_TESTED;
    classification = { ...classifyFailure('timed out'), class: 'ENV_TIMEOUT', aiRepair: false };
  } else if (cancelled) {
    status = STATUS.NOT_TESTED;
    classification = { class: 'ENV_CANCELLED', aiRepair: false, userEn: 'Cancelled.', userVi: 'Đã hủy.' };
  } else if (exitCode === 0) {
    status = STATUS.PASS;
  } else {
    classification = classifyFailure(`${stderrTail}\n${stdoutTail}`.slice(-8000));
    status = /^ENV_/.test(classification.class) ? STATUS.NOT_TESTED : STATUS.FAIL;
  }
  return {
    ok: status === STATUS.PASS,
    status,
    command: name,
    argv: argv.map((a) => redactText(a)),
    exitCode: exitCode ?? null,
    signal: signal || null,
    timedOut: Boolean(timedOut),
    cancelled: Boolean(cancelled),
    durationMs,
    stdoutTail,
    stderrTail,
    stdoutTruncated: out.truncated,
    stderrTruncated: err.truncated,
    classification,
    error: spawnError || (timedOut ? 'timeout' : cancelled ? 'cancelled' : exitCode === 0 ? null : `exit ${exitCode}`),
    // compat aliases
    stdout: stdoutTail,
    stderr: stderrTail,
  };
}

/**
 * Run a resolved command to completion.
 */
async function runResolved(resolved, { projectRoot, cwd, timeoutMs = 60_000, signal, port = null, extraEnv = {}, input = null, queueWaitMs, allowChildProcess = false } = {}) {
  let releaseFn = null;
  try {
    // Only heavy commands (install/test/build) share the FIFO queue; node --check is light.
    if (resolved.heavy) releaseFn = await acquire({ waitMs: queueWaitMs ?? DEFAULT_QUEUE_WAIT_MS, signal });
  } catch (e) {
    const out = createTail(); const err = createTail();
    const r = finish({ name: resolved.name, argv: resolved.argv, exitCode: null, cancelled: e.code === 'CANCELLED', timedOut: false, spawnError: e.code === 'CANCELLED' ? null : String(e.message), durationMs: 0, out, err });
    if (e.code === 'QUEUE_TIMEOUT') { r.status = STATUS.NOT_TESTED; r.classification = { class: 'ENV_QUEUE_TIMEOUT', aiRepair: false }; }
    await appendAudit({ command: resolved.name, argv: resolved.argv, status: r.status, error: r.error });
    return r;
  }
  const started = Date.now();
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'paf-exec-home-'));
  const out = createTail();
  const err = createTail();
  let child = null;
  let timedOut = false;
  let cancelled = false;
  let spawnError = null;
  let exitCode = null;
  let exitSignal = null;
  let timer = null;
  let onAbort = null;
  let streamsClosed = Promise.resolve();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const permArgs = buildNodePermissionArgs({ command: resolved.name, projectRoot: projectRoot || cwd, cwd, homeDir, writable: resolved.name === 'node.start', allowChildProcess });
  const effectiveArgs = [...permArgs, ...resolved.argv.slice(1)];
  try {
    const env = buildChildEnv({ nodeEnv: resolved.nodeEnv, homeDir, cacheDir: npmCacheDir(homeDir, resolved.network), port, extraEnv: { TMPDIR: homeDir, ...extraEnv } });
    await new Promise((resolve) => {
      try {
        child = spawn(binaryFor(resolved.argv[0]), effectiveArgs, { cwd, env, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) { spawnError = String(e.message || e); return resolve(); }
      child.stdout.on('data', (b) => out.push(b));
      child.stderr.on('data', (b) => err.push(b));
      streamsClosed = Promise.all([
        new Promise((r) => child.stdout.once('close', r)),
        new Promise((r) => child.stderr.once('close', r)),
      ]);
      child.on('error', (e) => { spawnError = String(e.message || e); resolve(); });
      child.on('exit', (code, sig) => { exitCode = code; exitSignal = sig; resolve(); });
      if (input != null) child.stdin.write(String(input));
      child.stdin.end();
      timer = setTimeout(() => { timedOut = true; killGroup(child.pid).catch(() => {}); }, timeoutMs);
      if (signal) {
        onAbort = () => { cancelled = true; killGroup(child.pid).catch(() => {}); };
        if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  } finally {
    clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener?.('abort', onAbort);
    // Let buffered output drain, then ALWAYS clean the whole process group — grandchildren must
    // never outlive the call (they could also hold the pipes open forever).
    await Promise.race([streamsClosed, sleep(300)]);
    if (child?.pid) await killGroup(child.pid, 500);
    await Promise.race([streamsClosed, sleep(500)]);
    await fsp.rm(homeDir, { recursive: true, force: true }).catch(() => {});
    releaseFn?.();
  }
  const result = finish({ name: resolved.name, argv: resolved.argv, exitCode, signal: exitSignal, timedOut, cancelled, spawnError, durationMs: Date.now() - started, out, err });
  await appendAudit({ command: resolved.name, argv: result.argv, cwd: path.basename(String(cwd || '')), status: result.status, exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut, cancelled: result.cancelled, durationMs: result.durationMs, class: result.classification?.class || null });
  return result;
}

function rejected(reason, name = null) {
  return {
    ok: false, status: STATUS.FAIL, command: name, argv: [], exitCode: null, signal: null, timedOut: false, cancelled: false,
    durationMs: 0, stdoutTail: '', stderrTail: '', stdout: '', stderr: '', classification: { class: 'POLICY_REJECTED', aiRepair: false },
    error: `policy: ${reason}`, policyRejected: true,
  };
}

/** Run a named command, e.g. execNamed('npm.test', [], { projectRoot }). */
export async function execNamed(name, args = [], opts = {}) {
  const projectRoot = opts.projectRoot || opts.cwd;
  if (!projectRoot) return rejected('projectRoot required', name);
  const resolved = resolveNamedCommand(name, args, { projectRoot });
  if (!resolved.ok) {
    await appendAudit({ command: name, args, status: 'REJECTED', reason: resolved.reason });
    return rejected(resolved.reason, name);
  }
  const cwd = opts.cwd || projectRoot;
  const r = path.resolve(projectRoot);
  if (path.resolve(cwd) !== r && !path.resolve(cwd).startsWith(r + path.sep)) return rejected('cwd outside project root', name);
  return runResolved(resolved, { ...opts, projectRoot, cwd });
}

/** Back-compat entry: raw argv is parsed into a named command (and rejected if it does not map). */
export async function execControlled(argv, { cwd, projectRoot, timeoutMs = 60_000, env = {}, input = null, signal, port, queueWaitMs, allowChildProcess = false } = {}) {
  const parsed = parseArgv(argv);
  if (!parsed.ok) {
    await appendAudit({ argv: Array.isArray(argv) ? argv : [], status: 'REJECTED', reason: parsed.reason });
    return rejected(parsed.reason);
  }
  return execNamed(parsed.name, parsed.args, { cwd, projectRoot: projectRoot || cwd, timeoutMs, extraEnv: env, input, signal, port, queueWaitMs, allowChildProcess });
}

// ---------------------------------------------------------------- long-running app processes
const liveApps = new Set();
let exitHookInstalled = false;
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => { for (const h of liveApps) { try { process.kill(-h.pid, 'SIGKILL'); } catch { /* */ } } });
}

/**
 * Start an app (node.start / npm.start) as a tracked process group. Not queued: the caller holds it
 * only while probing and must call stop(). Returns { ok, handle | error }.
 */
export async function startControlled(name, args = [], { projectRoot, cwd, port, extraEnv = {}, signal, allowChildProcess = false } = {}) {
  if (!['node.start', 'npm.start'].includes(name)) return rejected('only node.start / npm.start may run as an app', name);
  const resolved = resolveNamedCommand(name, args, { projectRoot });
  if (!resolved.ok) return rejected(resolved.reason, name);
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'paf-app-home-'));
  const env = buildChildEnv({ nodeEnv: 'production', homeDir, cacheDir: npmCacheDir(homeDir, false), port, extraEnv: { HOST: '0.0.0.0', TMPDIR: homeDir, ...extraEnv } });
  const permArgs = buildNodePermissionArgs({ command: name, projectRoot, cwd: cwd || projectRoot, homeDir, writable: true, allowChildProcess });
  const effectiveArgs = [...permArgs, ...resolved.argv.slice(1)];
  const out = createTail();
  const err = createTail();
  let child;
  try {
    child = spawn(binaryFor(resolved.argv[0]), effectiveArgs, { cwd: cwd || projectRoot, env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    await fsp.rm(homeDir, { recursive: true, force: true }).catch(() => {});
    return { ...rejected(String(e.message || e), name), status: STATUS.NOT_AVAILABLE };
  }
  const started = Date.now();
  let exited = null;
  const exitPromise = new Promise((resolve) => {
    child.on('exit', (code, sig) => { exited = { code, signal: sig, at: Date.now() }; resolve(exited); });
    child.on('error', (e) => { exited = { code: null, signal: null, error: String(e.message || e), at: Date.now() }; resolve(exited); });
  });
  child.stdout.on('data', (b) => out.push(b));
  child.stderr.on('data', (b) => err.push(b));
  const handle = {
    pid: child.pid,
    port,
    name,
    startedAt: started,
    get exited() { return exited; },
    exitPromise,
    logs() { return { stdoutTail: redactText(out.text()), stderrTail: redactText(err.text()) }; },
    async stop() {
      liveApps.delete(handle);
      await killGroup(child.pid);
      await Promise.race([exitPromise, new Promise((r) => setTimeout(r, 1000))]);
      // A grandchild may still hold the pipes open; never let them keep the Builder's event loop alive.
      try { child.stdout?.destroy(); child.stderr?.destroy(); child.unref(); } catch { /* */ }
      await fsp.rm(homeDir, { recursive: true, force: true }).catch(() => {});
      await appendAudit({ command: name, argv: resolved.argv, event: 'stop', durationMs: Date.now() - started, exit: exited });
      return { stopped: true, alive: groupAlive(child.pid) };
    },
  };
  liveApps.add(handle);
  installExitHook();
  if (signal) signal.addEventListener('abort', () => { handle.stop().catch(() => {}); }, { once: true });
  await appendAudit({ command: name, argv: resolved.argv, event: 'start', port });
  return { ok: true, status: STATUS.PASS, handle };
}

export function liveAppCount() { return liveApps.size; }
export async function stopAllApps() { for (const h of [...liveApps]) await h.stop().catch(() => {}); }
export { groupAlive };
