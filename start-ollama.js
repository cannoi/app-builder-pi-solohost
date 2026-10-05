/**
 * Ensure managed Ollama is running inside this process/container.
 * Works even when SoloHost overrides ENTRYPOINT and only runs `node index.js`.
 * No docker.sock. No host install.
 */
import { spawn, execFileSync } from 'node:child_process';
import { accessSync, constants, mkdirSync } from 'node:fs';
import { createWriteStream } from 'node:fs';
import path from 'node:path';

const OLLAMA_HOST = process.env.OLLAMA_HOST || '127.0.0.1:11434';
const OLLAMA_MODELS = process.env.OLLAMA_MODELS || '/app/ollama-data';
const BASE = process.env.OLLAMA_BASE_URL || `http://${OLLAMA_HOST.replace(/^https?:\/\//, '')}`;
const LOG = path.join(process.env.DATA_DIR || '/app/data', 'ollama-serve.log');

function whichOllama() {
  const candidates = ['/usr/local/bin/ollama', '/usr/bin/ollama', 'ollama'];
  for (const c of candidates) {
    try {
      if (c === 'ollama') {
        execFileSync('ollama', ['--version'], { stdio: 'ignore', timeout: 5000 });
        return 'ollama';
      }
      accessSync(c, constants.X_OK);
      return c;
    } catch {}
  }
  return null;
}

async function probe(timeoutMs = 2500) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${BASE.replace(/\/$/, '')}/api/tags`, { signal: ctrl.signal });
    return r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

export async function ensureOllama() {
  process.env.OLLAMA_HOST = OLLAMA_HOST;
  process.env.OLLAMA_MODELS = OLLAMA_MODELS;
  process.env.OLLAMA_BASE_URL = BASE.startsWith('http') ? BASE : `http://${BASE}`;
  process.env.OLLAMA_NUM_PARALLEL = process.env.OLLAMA_NUM_PARALLEL || '1';
  process.env.OLLAMA_MAX_LOADED_MODELS = process.env.OLLAMA_MAX_LOADED_MODELS || '1';

  try {
    mkdirSync(OLLAMA_MODELS, { recursive: true });
  } catch {}

  if (await probe()) {
    console.log(`[hub] Ollama already reachable at ${BASE}`);
    return { ok: true, started: false, base: BASE };
  }

  const bin = whichOllama();
  if (!bin) {
    console.warn('[hub] ollama binary not found — Local AI disabled (cloud still works). Rebuild image with Dockerfile that installs ollama.');
    return { ok: false, started: false, error: 'OLLAMA_BINARY_MISSING', base: BASE };
  }

  console.log(`[hub] Starting managed Ollama: ${bin} serve (${OLLAMA_HOST}, models=${OLLAMA_MODELS})`);
  let logStream;
  try {
    logStream = createWriteStream(LOG, { flags: 'a' });
  } catch {
    logStream = 'ignore';
  }

  const child = spawn(bin, ['serve'], {
    env: { ...process.env, OLLAMA_HOST, OLLAMA_MODELS, HOME: process.env.HOME || '/root' },
    stdio: ['ignore', logStream === 'ignore' ? 'ignore' : 'pipe', logStream === 'ignore' ? 'ignore' : 'pipe'],
    detached: true
  });
  if (logStream !== 'ignore' && child.stdout) {
    child.stdout.pipe(logStream);
    child.stderr?.pipe(logStream);
  }
  child.unref();
  child.on('exit', (code, signal) => {
    console.warn(`[hub] Ollama process exited code=${code} signal=${signal}`);
  });

  // Wait up to ~90s for API
  for (let i = 0; i < 45; i++) {
    await new Promise(r => setTimeout(r, 2000));
    if (await probe()) {
      console.log('[hub] Ollama is ready');
      return { ok: true, started: true, base: BASE, pid: child.pid };
    }
  }

  console.warn('[hub] Ollama did not become ready in time — Local AI may stay unavailable; cloud providers still work');
  return { ok: false, started: true, error: 'OLLAMA_START_TIMEOUT', base: BASE, pid: child.pid };
}
