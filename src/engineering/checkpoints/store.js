/**
 * Manifest checkpoints. Since v1.10.0 the manifest walker (sha256 per file) is also used by
 * SnapshotStore (.snapshot-files.json "manifest"), so snapshots and checkpoints share one format.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { STATUS } from '../validation/status.js';

const IGNORE = new Set(['node_modules', '.git', 'snapshots', 'artifacts', 'logs', 'data']);

function shouldIgnore(name) {
  return IGNORE.has(name) || name.endsWith('.log');
}

export async function walkManifest(root, base = root, out = []) {
  let entries = [];
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (shouldIgnore(e.name)) continue;
    const abs = path.join(root, e.name);
    const rel = path.relative(base, abs).replace(/\\/g, '/');
    if (e.isDirectory()) await walkManifest(abs, base, out);
    else if (e.isFile()) {
      const buf = await fs.readFile(abs);
      out.push({
        path: rel,
        size: buf.length,
        sha256: createHash('sha256').update(buf).digest('hex'),
      });
    }
  }
  return out;
}

async function copyFiltered(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    if (shouldIgnore(e.name)) continue;
    const from = path.join(src, e.name);
    const to = path.join(dest, e.name);
    if (e.isDirectory()) await copyFiltered(from, to);
    else if (e.isFile()) {
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.copyFile(from, to);
    }
  }
}

export async function createCheckpoint(sourceDir, checkpointDir, { reason = '', taskId = null } = {}) {
  if (!sourceDir || !checkpointDir) {
    return { ok: false, status: STATUS.NOT_AVAILABLE, error: 'missing paths' };
  }
  const id = `cp_${Date.now().toString(36)}`;
  const dest = path.join(checkpointDir, id);
  await copyFiltered(sourceDir, path.join(dest, 'source'));
  const manifest = await walkManifest(path.join(dest, 'source'));
  const meta = {
    id,
    reason,
    taskId,
    createdAt: new Date().toISOString(),
    fileCount: manifest.length,
    totalBytes: manifest.reduce((a, m) => a + m.size, 0),
  };
  await fs.writeFile(path.join(dest, 'manifest.json'), JSON.stringify({ meta, files: manifest }, null, 2));
  return { ok: true, status: STATUS.PASS, data: meta };
}

export async function diffManifests(aFiles = [], bFiles = []) {
  const mapA = new Map(aFiles.map((f) => [f.path, f]));
  const mapB = new Map(bFiles.map((f) => [f.path, f]));
  const added = [];
  const removed = [];
  const modified = [];
  for (const [p, f] of mapB) {
    if (!mapA.has(p)) added.push(p);
    else if (mapA.get(p).sha256 !== f.sha256) modified.push(p);
  }
  for (const p of mapA.keys()) if (!mapB.has(p)) removed.push(p);
  return { added, removed, modified };
}
