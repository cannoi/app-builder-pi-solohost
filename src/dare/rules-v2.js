/**
 * DARE v2 rules (v1.10.0, M4) — deterministic fixes fed by toolkit findings.
 *
 * Contract for every rule:
 *   detect(finding, ctx) → plan | null     (pure, reads files only)
 *   plan = { ruleId, fingerprint, files: [{ path, content }], risk, summary }
 *   The engine writes ONLY plan.files (relative, path-safe), takes a checkpoint first, re-validates,
 *   and rolls back on regression. A rule that cannot produce a minimal, unambiguous patch returns null
 *   and the issue is passed to AI with evidence instead (never a guess).
 */
import fs from 'node:fs/promises';
import path from 'node:path';

async function read(dir, rel) { try { return await fs.readFile(path.join(dir, rel), 'utf8'); } catch { return null; } }
async function exists(dir, rel) { try { await fs.access(path.join(dir, rel)); return true; } catch { return false; } }
const lineIndex = (text, line) => text.split('\n').slice(0, Math.max(0, line - 1)).join('\n').length + (line > 1 ? 1 : 0);

export const RULES = [];
const rule = (r) => { RULES.push(r); return r; };

rule({
  id: 'IMPORT_EXT_OR_CASE',
  risk: 'LOW',
  match: (f) => (f.kind === 'IMPORT_EXT' || f.kind === 'IMPORT_CASE') && f.fix && f.spec && f.file,
  async detect(f, { dir }) {
    const text = await read(dir, f.file);
    if (text == null) return null;
    const lines = text.split('\n');
    const i = (f.line || 1) - 1;
    const cur = lines[i] || '';
    const quoted = [`'${f.spec}'`, `"${f.spec}"`].find((q) => cur.includes(q));
    if (!quoted) return null;
    lines[i] = cur.replace(quoted, `${quoted[0]}${f.fix}${quoted[0]}`);
    return { files: [{ path: f.file, content: lines.join('\n') }], fingerprint: `${f.file}:${f.line}:${f.spec}`, summary: `${f.file}:${f.line} import "${f.spec}" → "${f.fix}"` };
  },
});

rule({
  id: 'PORT_MISMATCH',
  risk: 'LOW',
  match: (f) => f.kind === 'PORT_MISMATCH' && f.file,
  async detect(f, { dir }) {
    const text = await read(dir, f.file);
    if (text == null || /process\.env\.PORT/.test(text)) return null;
    const all = [...text.matchAll(/\.listen\s*\(\s*(\d{2,5})\b/g)];
    if (all.length !== 1) return null; // ambiguous → AI
    const m = all[0];
    const start = m.index + m[0].length - m[1].length;
    const content = `${text.slice(0, start)}(Number(process.env.PORT) || ${m[1]})${text.slice(start + m[1].length)}`;
    return { files: [{ path: f.file, content }], fingerprint: `${f.file}:listen:${m[1]}`, summary: `${f.file} listen(${m[1]}) → listen(process.env.PORT || ${m[1]})` };
  },
});

rule({
  id: 'BIND_ALL_INTERFACES',
  risk: 'LOW',
  match: (f) => f.kind === 'BIND_ALL_INTERFACES' && f.file,
  async detect(f, { dir }) {
    const text = await read(dir, f.file);
    if (text == null) return null;
    let content = text.replace(/(\.listen\s*\([^\n]*?)['"](127\.0\.0\.1|localhost)['"]/g, "$1'0.0.0.0'");
    content = content.replace(/((?:HOST|BIND)\s*=\s*[^;\n]*?)['"](127\.0\.0\.1|localhost)['"]/g, "$1'0.0.0.0'");
    if (content === text) return null;
    return { files: [{ path: f.file, content }], fingerprint: `${f.file}:bind`, summary: `${f.file} binds 0.0.0.0` };
  },
});

rule({
  id: 'START_SCRIPT_VARIANT',
  risk: 'LOW',
  match: (f) => f.kind === 'START_SCRIPT_MISSING' || (f.step === 'runtime.start' && /no start command|start script/i.test(f.message || '')),
  async detect(_f, { dir }) {
    const raw = await read(dir, 'package.json');
    if (!raw) return null;
    let pkg; try { pkg = JSON.parse(raw); } catch { return null; }
    const start = pkg.scripts?.start;
    const startFile = start && /^node\s+([\w./-]+\.(?:c|m)?js)\s*$/.exec(start)?.[1];
    if (start && (!startFile || await exists(dir, startFile))) return null;
    const candidates = [];
    for (const c of ['server.js', 'src/server.js', 'index.js', 'src/index.js', 'app.js', 'src/app.js', 'main.js']) if (await exists(dir, c)) candidates.push(c);
    if (pkg.main && await exists(dir, pkg.main) && !candidates.includes(pkg.main)) candidates.unshift(pkg.main);
    if (candidates.length !== 1) return null;
    const next = { ...pkg, scripts: { ...(pkg.scripts || {}), start: `node ${candidates[0]}` } };
    return { files: [{ path: 'package.json', content: `${JSON.stringify(next, null, 2)}\n` }], fingerprint: `start:${candidates[0]}`, summary: `package.json start → node ${candidates[0]}` };
  },
});

rule({
  id: 'MISSING_HEALTH_ENDPOINT',
  risk: 'MEDIUM',
  match: (f) => f.kind === 'MISSING_HEALTH_ENDPOINT' || (f.step === 'http.health' && /MISSING_HEALTH_ENDPOINT|→\s*404/i.test(f.message || '')),
  async detect(_f, { dir, fingerprint }) {
    const entry = fingerprint?.entrypoint;
    if (!entry || String(entry).startsWith('script:')) return null;
    const text = await read(dir, entry);
    if (text == null || /['"`]\/(?:api\/)?health['"`]/.test(text)) return null;
    const expressApp = [...text.matchAll(/^(\s*)(?:const|let|var)\s+(\w+)\s*=\s*express\(\s*\)\s*;?\s*$/gm)];
    if (expressApp.length === 1) {
      const m = expressApp[0];
      const at = m.index + m[0].length;
      const ins = `\n${m[1]}${m[2]}.get('/health', (_req, res) => res.json({ ok: true }));`;
      return { files: [{ path: entry, content: text.slice(0, at) + ins + text.slice(at) }], fingerprint: `${entry}:health:express`, summary: `${entry}: add GET /health` };
    }
    const pathDecl = [...text.matchAll(/^(\s*)(?:const|let)\s+(pathname|pathName|urlPath)\s*=.*$/gm)];
    if (pathDecl.length === 1 && /createServer\s*\(/.test(text)) {
      const m = pathDecl[0];
      const at = m.index + m[0].length;
      const ins = `\n${m[1]}if (${m[2]} === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); return; }`;
      return { files: [{ path: entry, content: text.slice(0, at) + ins + text.slice(at) }], fingerprint: `${entry}:health:http`, summary: `${entry}: add GET /health` };
    }
    return null;
  },
});

rule({
  id: 'ENV_VAR_UNDECLARED',
  risk: 'LOW',
  match: (f) => f.kind === 'ENV_VAR_UNDECLARED' && /^[A-Z][A-Z0-9_]+$/.test(f.name || ''),
  async detect(f, { dir, findings }) {
    // batch every undeclared var in one patch so the rule fires once
    const names = [...new Set((findings || []).filter((x) => x.kind === 'ENV_VAR_UNDECLARED' && /^[A-Z][A-Z0-9_]+$/.test(x.name || '')).map((x) => x.name).concat([f.name]))].sort();
    const cur = (await read(dir, '.env.example')) || '';
    const have = new Set(cur.split(/\r?\n/).map((l) => l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1]).filter(Boolean));
    const add = names.filter((n) => !have.has(n));
    if (!add.length) return null;
    const content = `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${add.map((n) => `${n}=`).join('\n')}\n`;
    return { files: [{ path: '.env.example', content }], fingerprint: `env:${add.join(',')}`, summary: `.env.example declares ${add.join(', ')}` };
  },
});

/** Never patched deterministically: the UI calls an API the server lacks → AI with exact evidence. */
export const AI_ONLY_KINDS = new Set(['broken_reference', 'CLIENT_API_ROUTE_MISSING', 'ROUTE_PROBE', 'IMPORT_NOT_FOUND', 'NODE_MODULE_MISSING', 'SYNTAX']);

export function findingName(f) { return f.name || (/^([A-Z][A-Z0-9_]+) is read/.exec(f.message || '')?.[1]) || null; }
