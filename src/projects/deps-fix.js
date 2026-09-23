import fs from 'node:fs/promises';
import path from 'node:path';
import { listFiles } from '../utils/fsx.js';

const BUILTIN = new Set([
  'assert', 'buffer', 'child_process', 'cluster', 'crypto', 'dgram', 'dns', 'events',
  'fs', 'http', 'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks',
  'process', 'punycode', 'querystring', 'readline', 'stream', 'string_decoder',
  'timers', 'tls', 'tty', 'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib',
]);

const NATIVE = new Set(['sqlite3', 'better-sqlite3', 'bcrypt', 'sharp', 'canvas']);

export async function findMissingNodeModules(sourceDir) {
  const pkg = JSON.parse(await fs.readFile(path.join(sourceDir, 'package.json'), 'utf8').catch(() => '{}'));
  const declared = new Set([
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ]);
  const files = await listFiles(sourceDir);
  const used = new Set();
  for (const rel of files) {
    if (!/\.(js|mjs|cjs)$/.test(rel)) continue;
    if (rel.startsWith('node_modules/') || rel.startsWith('solohost/')) continue;
    const text = await fs.readFile(path.join(sourceDir, rel), 'utf8').catch(() => '');
    for (const m of text.matchAll(/require\(\s*['"]([^'"./][^'"]*)['"]\s*\)/g)) used.add(m[1].split('/')[0]);
    for (const m of text.matchAll(/from\s+['"]([^'"./][^'"]*)['"]/g)) used.add(m[1].split('/')[0]);
  }
  const missing = [...used].filter((name) => name && !name.startsWith('node:') && !BUILTIN.has(name) && !declared.has(name));
  return { missing, used: [...used], declared: [...declared] };
}

export async function ensureMissingDependencies(sourceDir) {
  const { missing } = await findMissingNodeModules(sourceDir);
  if (!missing.length) return { changed: false, added: [], dockerfile: false };
  const pkgPath = path.join(sourceDir, 'package.json');
  const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
  pkg.dependencies = pkg.dependencies || {};
  for (const name of missing) {
    if (!pkg.dependencies[name] && !pkg.devDependencies?.[name]) pkg.dependencies[name] = '*';
  }
  await fs.writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  const native = missing.some((name) => NATIVE.has(name));
  let dockerfile = false;
  if (native) {
    const dfPath = path.join(sourceDir, 'Dockerfile');
    let df = await fs.readFile(dfPath, 'utf8').catch(() => '');
    if (df && !/python3 make g\+\+/.test(df)) {
      if (/^FROM .+$/m.test(df)) {
        df = df.replace(/^(FROM .+)$/m, `$1\nRUN apk add --no-cache python3 make g++ || apt-get update && apt-get install -y python3 make g++ || true`);
      } else {
        df = `FROM node:20-alpine\nRUN apk add --no-cache python3 make g++\n${df}`;
      }
      await fs.writeFile(dfPath, df);
      dockerfile = true;
    }
  }
  return { changed: true, added: missing, dockerfile, native };
}
