/**
 * Fast, dependency-free syntax gate for proposed files (runs BEFORE anything is written).
 * JS/MJS/CJS via `node --check`, JSON via JSON.parse. Other types are not checked here.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function syntaxCheckFiles(files = [], { timeoutMs = 8000 } = {}) {
  const errors = [];
  let tmp = null;
  for (const f of files) {
    const rel = String(f?.path || '');
    const content = typeof f?.content === 'string' ? f.content : null;
    if (content == null) continue;
    if (/\.json$/i.test(rel)) {
      try { JSON.parse(content); } catch (e) { errors.push({ path: rel, kind: 'json', message: String(e.message).slice(0, 300) }); }
      continue;
    }
    if (/\.(?:js|mjs|cjs)$/i.test(rel)) {
      if (!tmp) tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-syntax-'));
      // Keep the real extension so module syntax (.mjs) / CommonJS (.cjs) / auto-detect (.js) are judged correctly.
      const file = path.join(tmp, `${errors.length}-${path.basename(rel)}`);
      await fs.writeFile(file, content, 'utf8');
      try {
        await exec(process.execPath, ['--check', file], { timeout: timeoutMs });
      } catch (e) {
        const msg = String(e.stderr || e.message || '').split('\n').filter(Boolean).slice(0, 4).join(' | ').replace(file, rel);
        errors.push({ path: rel, kind: 'js', message: msg.slice(0, 400) });
      }
    }
  }
  if (tmp) await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  return { ok: errors.length === 0, errors };
}

export function describeSyntaxErrors(errors = []) {
  return errors.slice(0, 6).map((e) => `- ${e.path}: ${e.message}`).join('\n');
}

export default { syntaxCheckFiles, describeSyntaxErrors };
