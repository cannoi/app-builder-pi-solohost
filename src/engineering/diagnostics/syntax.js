/**
 * Syntax check via the controlled executor (node.check) — no direct spawn (rule 0.6).
 * Returns file:line evidence parsed from node's stderr.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { STATUS } from '../validation/status.js';
import { execNamed } from '../executor/exec.js';

async function listJsFiles(root, max = 40) {
  const out = [];
  async function walk(dir, depth = 0) {
    if (out.length >= max || depth > 4) return;
    let entries = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= max) break;
      if (['node_modules', '.git', 'dist', 'snapshots', 'artifacts', 'coverage', 'data'].includes(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) await walk(abs, depth + 1);
      else if (/\.(js|mjs|cjs)$/.test(e.name)) out.push(abs);
    }
  }
  await walk(root);
  return out;
}

export function parseNodeCheckError(stderr = '', rel = '') {
  const s = String(stderr || '');
  const loc = new RegExp(`${rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+)`).exec(s) || /:(\d+)\n/.exec(s);
  const msg = /(SyntaxError:[^\n]*)/.exec(s)?.[1] || s.split('\n').find((l) => /Error/.test(l)) || s.split('\n')[0] || 'syntax error';
  return { line: loc ? Number(loc[1]) : null, message: msg.trim().slice(0, 300) };
}

export async function syntaxCheckProject(sourceDir) {
  if (!sourceDir) return { ok: false, status: STATUS.NOT_AVAILABLE, error: 'no sourceDir' };
  const files = await listJsFiles(sourceDir);
  if (!files.length) return { ok: true, status: STATUS.NOT_AVAILABLE, data: { files: [], message: 'no JS files', failed: [] } };
  const failed = [];
  let checked = 0;
  for (const abs of files.slice(0, 30)) {
    const rel = path.relative(sourceDir, abs).replace(/\\/g, '/');
    const r = await execNamed('node.check', [rel], { projectRoot: sourceDir, timeoutMs: 15_000 });
    checked += 1;
    if (r.policyRejected) continue;
    if (r.status === 'NOT_AVAILABLE' || r.status === 'NOT_TESTED') continue;
    if (!r.ok) {
      const p = parseNodeCheckError(r.stderrTail, rel);
      failed.push({ path: rel, line: p.line, error: p.message, message: `${rel}${p.line ? `:${p.line}` : ''} ${p.message}` });
    }
  }
  return {
    ok: failed.length === 0,
    status: failed.length ? STATUS.FAIL : STATUS.PASS,
    data: { checked, failed },
    error: failed.length ? failed.slice(0, 3).map((f) => f.message).join('; ') : undefined,
  };
}
