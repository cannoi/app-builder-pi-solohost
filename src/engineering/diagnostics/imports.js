/**
 * Import diagnostics (v1.10.0, M2/M4): broken relative imports, missing extension in ESM,
 * wrong letter case (works on macOS/Windows, breaks on Linux/Pi), with file:line evidence.
 * Pure read-only static analysis. Also proposes a fix candidate only when exactly one exists.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { STATUS } from '../validation/status.js';

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'snapshots', 'artifacts', 'data', 'logs']);
const EXT = ['.js', '.mjs', '.cjs', '.json'];

async function listCode(root, rel = '', out = [], depth = 0) {
  if (out.length > 400 || depth > 8) return out;
  let entries = [];
  try { entries = await fs.readdir(path.join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) await listCode(root, r, out, depth + 1);
    else if (/\.(c|m)?js$/.test(e.name)) out.push(r);
  }
  return out;
}

async function dirEntries(root, relDir, cache) {
  if (cache.has(relDir)) return cache.get(relDir);
  let names = [];
  try { names = await fs.readdir(path.join(root, relDir)); } catch { names = null; }
  cache.set(relDir, names);
  return names;
}

function lineOf(text, index) {
  let n = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) n += 1;
  return n;
}

function isEsm(rel, text, pkgType) {
  if (rel.endsWith('.mjs')) return true;
  if (rel.endsWith('.cjs')) return false;
  if (pkgType === 'module') return true;
  return /^\s*(import|export)\s/m.test(text) && !/\brequire\s*\(/.test(text);
}

/** Resolve one specifier relative to `fromRel`. Returns { ok, exact, caseFix, extFix, candidates }. */
async function resolveSpec(root, fromRel, spec, esm, cache) {
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  if (target.startsWith('..')) return { ok: false, outside: true };
  const dir = path.posix.dirname(target);
  const base = path.posix.basename(target);
  const names = await dirEntries(root, dir === '.' ? '' : dir, cache);
  if (!names) {
    // directory itself may be wrong case
    return { ok: false, candidates: [] };
  }
  const hasExt = /\.[a-z0-9]+$/i.test(base);
  if (names.includes(base)) {
    const st = await fs.stat(path.join(root, target)).catch(() => null);
    if (st?.isFile()) return { ok: true };
    if (st?.isDirectory()) {
      const inner = await dirEntries(root, target, cache);
      if (inner?.includes('index.js')) return esm ? { ok: false, extFix: `${spec.replace(/\/$/, '')}/index.js`, reason: 'directory import needs /index.js in ESM' } : { ok: true };
    }
  }
  if (!hasExt) {
    const withExt = EXT.map((e) => base + e).filter((n) => names.includes(n));
    if (withExt.length) {
      if (!esm) return { ok: true };
      return withExt.length === 1 ? { ok: false, extFix: spec + withExt[0].slice(base.length), reason: 'missing file extension (ESM requires it)' } : { ok: false, candidates: withExt };
    }
  }
  const lower = base.toLowerCase();
  const caseMatches = names.filter((n) => n.toLowerCase() === lower || (!hasExt && EXT.some((e) => n.toLowerCase() === lower + e)));
  if (caseMatches.length === 1) {
    const fixed = caseMatches[0];
    const fixedSpec = spec.slice(0, spec.length - base.length) + (hasExt || !esm ? (hasExt ? fixed : fixed.replace(/\.(c|m)?js$/, '')) : fixed);
    return { ok: false, caseFix: fixedSpec, reason: `wrong letter case (file is ${fixed})` };
  }
  return { ok: false, candidates: caseMatches };
}

export async function checkImports(sourceDir) {
  if (!sourceDir) return { ok: false, status: STATUS.NOT_AVAILABLE, error: 'no sourceDir' };
  let pkgType = 'commonjs';
  try { pkgType = JSON.parse(await fs.readFile(path.join(sourceDir, 'package.json'), 'utf8')).type || 'commonjs'; } catch { /* */ }
  const files = await listCode(sourceDir);
  if (!files.length) return { ok: true, status: STATUS.NOT_AVAILABLE, data: { message: 'no JS files', findings: [] } };
  const cache = new Map();
  const findings = [];
  const re = /(?:\bimport\s+(?:[^'"]*?\s+from\s+)?|\bexport\s+[^'"]*?\s+from\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)['"](\.{1,2}\/[^'"]+|\.{1,2})['"]/g;
  for (const rel of files) {
    if (rel.startsWith('public/')) continue; // browser modules are resolved by URL, checked by route intel
    const text = await fs.readFile(path.join(sourceDir, rel), 'utf8').catch(() => '');
    if (!text) continue;
    const esm = isEsm(rel, text, pkgType);
    let m;
    while ((m = re.exec(text))) {
      const spec = m[1];
      const isRequire = /require\s*\($/.test(text.slice(m.index, m.index + m[0].indexOf(spec) - 1).trim()) || /require\s*\(/.test(m[0]);
      const r = await resolveSpec(sourceDir, rel, spec, esm && !isRequire, cache);
      if (r.ok || r.outside) continue;
      const line = lineOf(text, m.index);
      let kind = 'IMPORT_NOT_FOUND';
      let fix = null;
      if (r.caseFix) { kind = 'IMPORT_CASE'; fix = r.caseFix; }
      else if (r.extFix) { kind = 'IMPORT_EXT'; fix = r.extFix; }
      findings.push({ kind, file: rel, line, spec, fix, reason: r.reason || (r.candidates?.length > 1 ? `ambiguous: ${r.candidates.join(', ')}` : 'file not found'), message: `${rel}:${line} imports "${spec}" — ${r.reason || 'file not found'}${fix ? ` (did you mean "${fix}")` : ''}` });
    }
  }
  return {
    ok: findings.length === 0,
    status: findings.length ? STATUS.FAIL : STATUS.PASS,
    data: { checked: files.length, findings: findings.slice(0, 40) },
    error: findings.length ? findings.slice(0, 3).map((f) => f.message).join('; ') : undefined,
  };
}
