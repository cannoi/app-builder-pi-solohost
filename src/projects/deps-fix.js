import fs from 'node:fs/promises';
import path from 'node:path';
import { builtinModules, isBuiltin } from 'node:module';
import { listFiles } from '../utils/fsx.js';

const BUILTIN = new Set(builtinModules.map((name) => name.replace(/^node:/, '').split('/')[0]));
const NATIVE = new Set(['sqlite3', 'better-sqlite3', 'bcrypt', 'sharp', 'canvas']);

function packageRoot(specifier = '') {
  const value = String(specifier).trim();
  if (!value || value.startsWith('.') || value.startsWith('#') || value.startsWith('node:')) return '';
  if (value.startsWith('@')) {
    const parts = value.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : value;
  }
  return value.split('/')[0];
}

function declaredPackages(pkg = {}) {
  return new Set([
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
    ...Object.keys(pkg.optionalDependencies || {}),
    ...Object.keys(pkg.peerDependencies || {}),
  ]);
}

function importedPackages(text = '') {
  const used = new Set();
  const patterns = [
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s+(?:[^'"]+?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bexport\s+(?:[^'"]+?\s+from\s+)?['"]([^'"]+)['"]/g,
  ];
  for (const re of patterns) {
    for (const match of text.matchAll(re)) {
      const root = packageRoot(match[1]);
      if (root && !isBuiltin(match[1]) && !BUILTIN.has(root)) used.add(root);
    }
  }
  return used;
}

export async function findMissingNodeModules(sourceDir) {
  const pkg = JSON.parse(await fs.readFile(path.join(sourceDir, 'package.json'), 'utf8').catch(() => '{}'));
  const declared = declaredPackages(pkg);
  const files = await listFiles(sourceDir);
  const used = new Set();

  for (const rel of files) {
    if (!/\.(js|mjs|cjs|jsx|ts|tsx)$/.test(rel)) continue;
    if (rel.startsWith('node_modules/') || rel.startsWith('solohost/')) continue;
    const text = await fs.readFile(path.join(sourceDir, rel), 'utf8').catch(() => '');
    for (const name of importedPackages(text)) used.add(name);
  }

  const missing = [...used].filter((name) => !declared.has(name));
  return { missing, used: [...used], declared: [...declared] };
}

function detectPackageManager(sourceDir) {
  // Deterministic priority: the lockfile is the project's package-manager contract.
  return fs.access(path.join(sourceDir, 'pnpm-lock.yaml')).then(() => 'pnpm').catch(() =>
    fs.access(path.join(sourceDir, 'yarn.lock')).then(() => 'yarn').catch(() =>
      fs.access(path.join(sourceDir, 'bun.lock')).then(() => 'bun').catch(() =>
        fs.access(path.join(sourceDir, 'bun.lockb')).then(() => 'bun').catch(() => 'npm')
      )
    )
  );
}

export function nativePackages(names = []) {
  return names.filter((name) => NATIVE.has(name));
}

export async function ensureMissingDependencies(sourceDir, onlyPackage = '') {
  const { missing } = await findMissingNodeModules(sourceDir);
  const target = String(onlyPackage || '').trim();
  const selected = target && missing.includes(target) ? [target] : missing;
  if (!selected.length) return { changed: false, added: [], dockerfile: false, packageManager: await detectPackageManager(sourceDir) };

  const pkgPath = path.join(sourceDir, 'package.json');
  const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
  pkg.dependencies = { ...(pkg.dependencies || {}) };

  for (const name of selected) {
    if (!pkg.dependencies[name] && !pkg.devDependencies?.[name] && !pkg.optionalDependencies?.[name] && !pkg.peerDependencies?.[name]) {
      // Keep the source patch deterministic. The existing package manager resolves
      // the concrete version during the next install/build and refreshes its lockfile.
      pkg.dependencies[name] = '*';
    }
  }

  await fs.writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  return {
    changed: true,
    added: selected,
    dockerfile: false,
    native: nativePackages(selected).length > 0,
    packageManager: await detectPackageManager(sourceDir),
  };
}

export { packageRoot };
