/**
 * Source mutation guard (v1.10.0, D-01).
 * Every shadow / validate entry point runs inside withSourceGuard(): a source manifest hash is computed
 * before and after. If anything changed, the tree is restored from a pre-run backup and the call FAILS
 * loudly (SHADOW_MUTATION) instead of silently returning a result.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const IGNORE_DIRS = new Set(['node_modules', '.git', 'snapshots', 'artifacts', 'logs', 'data', '.cache']);

function ignored(name) {
  return IGNORE_DIRS.has(name) || name.endsWith('.log');
}

export async function sourceManifest(root) {
  const out = {};
  async function walk(dir, prefix) {
    let entries = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (ignored(e.name)) continue;
      const abs = path.join(dir, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(abs, rel);
      else if (e.isFile()) out[rel] = createHash('sha256').update(await fs.readFile(abs)).digest('hex');
    }
  }
  await walk(root, '');
  return out;
}

export function manifestDigest(manifest = {}) {
  return createHash('sha256').update(Object.keys(manifest).sort().map((k) => `${k}:${manifest[k]}`).join('\n')).digest('hex');
}

export function manifestDiff(a = {}, b = {}) {
  const names = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...names].filter((n) => a[n] !== b[n]).sort();
}

async function copyTree(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  for (const e of await fs.readdir(src, { withFileTypes: true })) {
    if (ignored(e.name)) continue;
    const from = path.join(src, e.name);
    const to = path.join(dest, e.name);
    if (e.isDirectory()) await copyTree(from, to);
    else if (e.isFile()) await fs.copyFile(from, to);
  }
}

async function restoreTree(backup, root, changed, before) {
  for (const rel of changed) {
    const target = path.join(root, rel);
    if (before[rel]) {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(path.join(backup, rel), target);
    } else {
      await fs.rm(target, { force: true });
    }
  }
}

export class SourceMutationError extends Error {
  constructor(changed, label) {
    super(`SHADOW_MUTATION: ${label} changed ${changed.length} source file(s): ${changed.slice(0, 10).join(', ')}. The tree was restored.`);
    this.code = 'SHADOW_MUTATION';
    this.changed = changed;
  }
}

/**
 * Run fn() and guarantee sourceDir is byte-identical afterwards.
 * @returns result of fn
 * @throws SourceMutationError (after restoring) when fn mutated the tree
 */
export async function withSourceGuard(sourceDir, fn, { label = 'engineering check' } = {}) {
  if (!sourceDir) return fn();
  const before = await sourceManifest(sourceDir);
  const backup = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-guard-'));
  try {
    await copyTree(sourceDir, backup);
    let result;
    let error = null;
    try { result = await fn(); } catch (err) { error = err; }
    const after = await sourceManifest(sourceDir);
    const changed = manifestDiff(before, after);
    if (changed.length) {
      await restoreTree(backup, sourceDir, changed, before);
      throw new SourceMutationError(changed, label);
    }
    if (error) throw error;
    return result;
  } finally {
    await fs.rm(backup, { recursive: true, force: true }).catch(() => {});
  }
}
