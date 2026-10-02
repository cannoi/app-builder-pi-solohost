import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function sourceFingerprint(sourceDir) {
  const files = await collectFiles(sourceDir);
  const hash = crypto.createHash('sha256');
  for (const rel of files) {
    const full = path.join(sourceDir, rel);
    const stat = await fs.lstat(full);
    if (!stat.isFile()) continue;
    const content = await fs.readFile(full);
    hash.update(rel.replace(/\\/g, '/'));
    hash.update('\0');
    hash.update(String(content.length));
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function collectFiles(root, prefix = '') {
  const entries = await fs.readdir(path.join(root, prefix), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && ['node_modules', '.git', 'snapshots'].includes(entry.name)) continue;
    const rel = prefix ? path.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) files.push(...await collectFiles(root, rel));
    else if (entry.isFile()) files.push(rel);
  }
  return files.sort((a, b) => a.localeCompare(b));
}

export function verificationMatchesSource(verification, runtime, sourceHash) {
  return Boolean(
    sourceHash
    && verification?.sourceHash === sourceHash
    && verification?.previewSourceHash === sourceHash
    && runtime?.sourceHash === sourceHash,
  );
}
