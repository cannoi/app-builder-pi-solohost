import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureDir } from '../utils/fsx.js';
import { readZip } from '../utils/zip.js';

const exec = promisify(execFile);

export async function importZipBuffer(buf, destDir) {
  await ensureDir(destDir);
  try {
    await readZip(buf, destDir);
  } catch {
    const zipPath = path.join(destDir, '_upload.zip');
    await fs.writeFile(zipPath, buf);
    try {
      await exec('unzip', ['-o', '-qq', zipPath, '-d', destDir], { timeout: 60000 });
    } catch {
      throw new Error('Could not unpack the ZIP. Use a standard .zip file without encryption.');
    } finally {
      await fs.rm(zipPath, { force: true }).catch(() => {});
    }
  }
  await flattenImportedTree(destDir);
  return detectStack(destDir);
}

export async function flattenImportedTree(destDir) {
  const skip = new Set(['__macosx', '.ds_store', '.git', 'node_modules']);
  let guard = 0;
  while (guard < 3) {
    guard += 1;
    const entries = (await fs.readdir(destDir, { withFileTypes: true }).catch(() => []))
      .filter((e) => !skip.has(e.name.toLowerCase()));
    if (entries.length !== 1 || !entries[0].isDirectory()) break;
    const inner = path.join(destDir, entries[0].name);
    const kids = await fs.readdir(inner);
    for (const name of kids) {
      const from = path.join(inner, name);
      const to = path.join(destDir, name);
      if (await fs.access(to).then(() => true).catch(() => false)) continue;
      await fs.rename(from, to);
    }
    await fs.rm(inner, { recursive: true, force: true }).catch(() => {});
  }
}

export async function detectStack(dir) {
  const names = new Set(await walkNames(dir));
  return {
    language: names.has('package.json') ? 'javascript' : names.has('requirements.txt') ? 'python' : 'unknown',
    docker: names.has('Dockerfile') || names.has('docker-compose.yml'),
    tests: [...names].some((n) => n.includes('test')),
    hasEnvExample: names.has('.env.example'),
    files: [...names].slice(0, 80),
  };
}

async function walkNames(dir, acc = [], prefix = '') {
  const entries = await fs.readdir(path.join(dir, prefix), { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      await walkNames(dir, acc, rel);
    } else acc.push(rel);
  }
  return acc;
}
