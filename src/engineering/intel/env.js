/**
 * Environment usage intel (v1.10.0): process.env reads in server code vs declarations in
 * .env.example / docker-compose.yml / config_options.yml, with file:line of the first use.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { STATUS } from '../validation/status.js';

const ENV_USE = /process\.env(?:\.([A-Z][A-Z0-9_]{1,64})|\[\s*['"]([A-Z][A-Z0-9_]{1,64})['"]\s*\])/g;
const IGNORE = new Set(['NODE_ENV', 'PORT', 'HOST', 'HOME', 'PATH', 'BIND', 'HOSTNAME', 'TZ', 'LANG', 'CI', 'npm_package_version', 'DEBUG']);
const SKIP = new Set(['node_modules', '.git', 'public', 'dist', 'build', 'coverage', 'tests', 'test', '__tests__', 'snapshots', 'artifacts', 'data', 'logs']);

async function readOptional(file) {
  try { return await fs.readFile(file, 'utf8'); } catch { return ''; }
}

async function listServerFiles(root, rel = '', out = [], depth = 0) {
  if (out.length > 200 || depth > 6) return out;
  let entries = [];
  try { entries = await fs.readdir(path.join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) await listServerFiles(root, r, out, depth + 1);
    else if (/\.(c|m)?js$/.test(e.name) && !/\.(test|spec)\./.test(e.name)) out.push(r);
  }
  return out;
}

export async function inspectEnv(sourceDir) {
  if (!sourceDir) return { ok: false, status: STATUS.NOT_AVAILABLE, error: 'no sourceDir' };
  const used = new Map();
  for (const rel of await listServerFiles(sourceDir)) {
    const text = await readOptional(path.join(sourceDir, rel));
    let m;
    const re = new RegExp(ENV_USE.source, 'g');
    while ((m = re.exec(text))) {
      const name = m[1] || m[2];
      if (!used.has(name)) used.set(name, { file: rel, line: text.slice(0, m.index).split('\n').length });
    }
  }
  const declared = new Set();
  const example = await readOptional(path.join(sourceDir, '.env.example'));
  for (const l of example.split(/\r?\n/)) { const mm = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/); if (mm) declared.add(mm[1]); }
  const declaredInExample = new Set(declared);
  for (const f of ['docker-compose.yml', 'compose.yml', 'solohost/docker-compose.yml', 'config_options.yml', 'solohost/config_options.yml']) {
    const t = await readOptional(path.join(sourceDir, f));
    for (const mm of t.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)) declared.add(mm[1]);
    for (const mm of t.matchAll(/^\s{4,}([A-Z][A-Z0-9_]+)\s*:/gm)) declared.add(mm[1]);
    for (const mm of t.matchAll(/name:\s*([A-Z][A-Z0-9_]+)/g)) declared.add(mm[1]);
  }
  const undeclared = [...used.keys()].filter((k) => !declared.has(k) && !IGNORE.has(k));
  const findings = undeclared.slice(0, 40).map((k) => ({ kind: 'ENV_VAR_UNDECLARED', name: k, file: used.get(k).file, line: used.get(k).line, message: `${k} is read at ${used.get(k).file}:${used.get(k).line} but not declared in .env.example / compose / config_options` }));
  return {
    ok: true,
    status: undeclared.length ? STATUS.WARNING : STATUS.PASS,
    error: findings.length ? findings.slice(0, 3).map((f) => f.message).join('; ') : undefined,
    data: {
      used: [...used.keys()].slice(0, 80),
      declaredInExample: [...declaredInExample].slice(0, 80),
      declared: [...declared].slice(0, 120),
      undeclared: undeclared.slice(0, 40),
      findings,
    },
  };
}
