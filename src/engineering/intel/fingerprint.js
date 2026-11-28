/**
 * Lightweight project fingerprint (deterministic, bounded).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { STATUS } from '../validation/status.js';

async function readText(root, rel, max = 64_000) {
  try {
    const p = path.join(root, rel);
    const st = await fs.stat(p);
    if (!st.isFile() || st.size > 512_000) return null;
    const buf = await fs.readFile(p, 'utf8');
    return buf.slice(0, max);
  } catch {
    return null;
  }
}

async function exists(root, rel) {
  try {
    await fs.access(path.join(root, rel));
    return true;
  } catch {
    return false;
  }
}

export async function buildFingerprint(sourceDir) {
  if (!sourceDir) {
    return { ok: false, status: STATUS.NOT_AVAILABLE, error: 'no sourceDir' };
  }
  const pkgRaw = await readText(sourceDir, 'package.json');
  let pkg = null;
  try { pkg = pkgRaw ? JSON.parse(pkgRaw) : null; } catch { pkg = null; }

  const hasDockerfile = await exists(sourceDir, 'Dockerfile');
  const hasCompose = (await exists(sourceDir, 'docker-compose.yml'))
    || (await exists(sourceDir, 'solohost/docker-compose.yml'));
  const hasConfigOptions = (await exists(sourceDir, 'config_options.yml'))
    || (await exists(sourceDir, 'solohost/config_options.yml'));
  const entryCandidates = ['src/server.js', 'server.js', 'index.js', 'src/index.js', 'app.js'];
  let entrypoint = null;
  for (const c of entryCandidates) {
    if (await exists(sourceDir, c)) { entrypoint = c; break; }
  }
  if (!entrypoint && pkg?.scripts?.start) {
    entrypoint = `script:${pkg.scripts.start}`;
  }

  let framework = 'unknown';
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  if (deps.express) framework = 'express';
  else if (deps.fastify) framework = 'fastify';
  else if (deps.next) framework = 'next';
  else if (pkg?.type === 'module' || entrypoint) framework = 'node';

  // Port heuristic
  let port = null;
  for (const rel of [entrypoint, 'Dockerfile', 'docker-compose.yml'].filter(Boolean)) {
    const text = await readText(sourceDir, rel);
    if (!text) continue;
    const m = text.match(/\bPORT\b[^\d]{0,12}(\d{2,5})/) || text.match(/listen\(\s*(\d{2,5})/) || text.match(/EXPOSE\s+(\d{2,5})/i);
    if (m) { port = Number(m[1]); break; }
  }

  const hash = createHash('sha256')
    .update(pkgRaw || '')
    .update(entrypoint || '')
    .update(String(hasDockerfile))
    .digest('hex')
    .slice(0, 16);

  return {
    ok: true,
    status: STATUS.PASS,
    data: {
      hash,
      framework,
      packageManager: (await exists(sourceDir, 'package-lock.json')) ? 'npm' : (pkg ? 'npm' : 'none'),
      entrypoint,
      port,
      hasDockerfile,
      hasCompose,
      hasConfigOptions,
      scripts: pkg?.scripts ? Object.keys(pkg.scripts).slice(0, 30) : [],
      moduleType: pkg?.type || 'commonjs',
      name: pkg?.name || null,
      version: pkg?.version || null,
    },
  };
}
