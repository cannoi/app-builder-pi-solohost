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
  return detectStack(destDir);
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
