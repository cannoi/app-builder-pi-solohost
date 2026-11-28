/**
 * Fast, dependency-free syntax gate for proposed files (runs BEFORE anything is written).
 * JS/MJS/CJS via `node --check`, inline <script> inside HTML via `node --check`, JSON via JSON.parse.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

function extractInlineScripts(html = '') {
  const blocks = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  let idx = 0;
  while ((m = re.exec(String(html || '')))) {
    idx += 1;
    const attrs = m[1] || '';
    const code = (m[2] || '').trim();
    if (!code) continue;
    // Skip non-JS script tags (e.g., application/ld+json, importmap) or external-only tags
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const typeMatch = attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i);
    const type = (typeMatch?.[1] || '').toLowerCase();
    if (type && !['text/javascript', 'application/javascript', 'module'].includes(type)) continue;
    const isModule = type === 'module';
    blocks.push({ idx, code, ext: isModule ? 'mjs' : 'js' });
  }
  return blocks;
}

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
      const file = path.join(tmp, `${errors.length}-${path.basename(rel)}`);
      await fs.writeFile(file, content, 'utf8');
      try {
        await exec(process.execPath, ['--check', file], { timeout: timeoutMs });
      } catch (e) {
        const msg = String(e.stderr || e.message || '').split('\n').filter(Boolean).slice(0, 4).join(' | ').replace(file, rel);
        errors.push({ path: rel, kind: 'js', message: msg.slice(0, 400) });
      }
      continue;
    }
    if (/\.html?$/i.test(rel)) {
      const blocks = extractInlineScripts(content);
      for (const blk of blocks) {
        if (!tmp) tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-syntax-'));
        const file = path.join(tmp, `${errors.length}-inline-${blk.idx}.${blk.ext}`);
        await fs.writeFile(file, blk.code, 'utf8');
        try {
          await exec(process.execPath, ['--check', file], { timeout: timeoutMs });
        } catch (e) {
          const msg = String(e.stderr || e.message || '').split('\n').filter(Boolean).slice(0, 4).join(' | ').replace(file, `${rel} <script #${blk.idx}>`);
          errors.push({ path: rel, kind: 'html-script', message: msg.slice(0, 400) });
        }
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
