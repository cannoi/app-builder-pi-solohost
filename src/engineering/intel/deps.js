import fs from 'node:fs/promises';
import path from 'node:path';
import { STATUS } from '../validation/status.js';

export async function inspectDeps(sourceDir) {
  if (!sourceDir) return { ok: false, status: STATUS.NOT_AVAILABLE, error: 'no sourceDir' };
  let pkg;
  try {
    pkg = JSON.parse(await fs.readFile(path.join(sourceDir, 'package.json'), 'utf8'));
  } catch {
    return { ok: false, status: STATUS.NOT_AVAILABLE, error: 'no package.json' };
  }
  const dependencies = Object.keys(pkg.dependencies || {}).slice(0, 120);
  const devDependencies = Object.keys(pkg.devDependencies || {}).slice(0, 120);
  let lock = 'none';
  for (const f of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']) {
    try { await fs.access(path.join(sourceDir, f)); lock = f; break; } catch { /* */ }
  }
  return {
    ok: true,
    status: STATUS.PASS,
    data: {
      name: pkg.name || null,
      version: pkg.version || null,
      engines: pkg.engines || {},
      dependencies,
      devDependencies,
      lockfile: lock,
      scripts: Object.keys(pkg.scripts || {}).slice(0, 40),
    },
  };
}
