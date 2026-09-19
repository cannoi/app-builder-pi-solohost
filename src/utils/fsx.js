import fs from 'node:fs/promises';
import path from 'node:path';

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function writeJson(file, value) {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, JSON.stringify(value, null, 2));
}

export function isSafeRelPath(rel) {
  if (!rel || typeof rel !== 'string') return false;
  if (path.isAbsolute(rel)) return false;
  const n = path.normalize(rel).replace(/\\/g, '/');
  if (n.startsWith('..') || n.includes('/../')) return false;
  if (n.includes('\0')) return false;
  return true;
}

export async function writeSafeFile(root, rel, content) {
  if (!isSafeRelPath(rel)) throw new Error(`Unsafe path rejected: ${rel}`);
  const target = path.join(root, rel);
  const resolved = path.resolve(target);
  const rootResolved = path.resolve(root);
  if (!resolved.startsWith(rootResolved + path.sep) && resolved !== rootResolved) {
    throw new Error('Path escaped project root');
  }
  await ensureDir(path.dirname(resolved));
  await fs.writeFile(resolved, content ?? '');
  return resolved;
}

export async function listFiles(root, acc = [], prefix = '') {
  let entries = [];
  try {
    entries = await fs.readdir(path.join(root, prefix), { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'snapshots') continue;
      await listFiles(root, acc, rel);
    } else {
      acc.push(rel);
    }
  }
  return acc;
}

export async function copyDir(src, dest) {
  await ensureDir(dest);
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const from = path.join(src, e.name);
    const to = path.join(dest, e.name);
    if (e.isDirectory()) await copyDir(from, to);
    else await fs.copyFile(from, to);
  }
}

export async function dirSizeBytes(root) {
  let total = 0;
  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        try { total += (await fs.stat(p)).size; } catch { /* ignore */ }
      }
    }
  }
  await walk(root);
  return total;
}

export async function zipLikeExport(root) {
  const files = await listFiles(root);
  const out = [];
  for (const rel of files) {
    const content = await fs.readFile(path.join(root, rel), 'utf8').catch(() => null);
    if (content != null) out.push({ path: rel, content });
  }
  return out;
}
