import fs from 'node:fs/promises';
import path from 'node:path';
import { listFiles } from '../utils/fsx.js';

const SKIP = /(^|\/)(node_modules|\.git|dist|build|coverage|\.next|vendor)(\/|$)/i;
const SENSITIVE = /(^|\/)(\.env(?!\.(example|sample|template)$)[^/]*|secrets?|credentials?)(\/|$)|(^|\/)(id_rsa|id_ed25519|.*\.(pem|key|p12|pfx))$/i;
const isReadableProjectPath = (rel) => !SKIP.test(rel) && !SENSITIVE.test(rel);

function safeRel(value) {
  const rel = String(value || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (!rel || rel.startsWith('/') || rel.includes('..')) throw new Error(`Unsafe path: ${rel}`);
  return rel;
}


async function safeReadFile(sourceDir, rel, maxBytes = 2 * 1024 * 1024) {
  const root = await fs.realpath(sourceDir);
  const normalized = safeRel(rel);
  if (!isReadableProjectPath(normalized)) throw new Error('Sensitive or generated paths are not available to Agent tools.');
  const parts = normalized.split('/');
  let cursor = root;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    const stat = await fs.lstat(cursor);
    if (stat.isSymbolicLink()) throw new Error('Symbolic links are not readable by Agent tools.');
  }
  const resolved = await fs.realpath(cursor);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error('Path escaped project root.');
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) throw new Error('Requested path is not a regular file.');
  if (stat.size > maxBytes) throw new Error(`File exceeds the ${maxBytes}-byte Agent read limit.`);
  return fs.readFile(resolved, 'utf8');
}

export async function runAgentTools({ sourceDir, actions = [] } = {}) {
  const out = [];
  for (const action of Array.isArray(actions) ? actions.slice(0, 8) : []) {
    const tool = String(action?.tool || '').trim();
    try {
      if (tool === 'list_files') {
        const files = (await listFiles(sourceDir)).filter(isReadableProjectPath);
        out.push({ tool, ok: true, files: files.slice(0, 300) });
      } else if (tool === 'search_text') {
        const query = String(action.query || '').trim().slice(0, 500);
        if (!query) throw new Error('search_text requires query');
        const files = (await listFiles(sourceDir)).filter(isReadableProjectPath).slice(0, 500);
        const matches = [];
        for (const rel of files) {
          const text = await safeReadFile(sourceDir, rel).catch(() => '');
          if (!text) continue;
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length && matches.length < 80; i += 1) {
            if (lines[i].toLowerCase().includes(query.toLowerCase())) {
              matches.push({ path: rel, line: i + 1, text: lines[i].slice(0, 500) });
            }
          }
          if (matches.length >= 80) break;
        }
        out.push({ tool, ok: true, query, matches });
      } else if (tool === 'read_file' || tool === 'read_range') {
        const rel = safeRel(action.path);
        const text = await safeReadFile(sourceDir, rel);
        const lines = text.split(/\r?\n/);
        const requestedStart = Number(action.startLine || 1);
        const start = Number.isFinite(requestedStart) ? Math.max(1, Math.floor(requestedStart)) : 1;
        const requestedEnd = Number(action.endLine || (tool === 'read_file' ? lines.length : start + 180));
        const end = Number.isFinite(requestedEnd) ? Math.min(lines.length, Math.max(start, Math.floor(requestedEnd))) : Math.min(lines.length, start + 180);
        out.push({ tool, ok: true, path: rel, content: lines.slice(start - 1, end).join('\n').slice(0, 14000), startLine: start, endLine: end });
      } else if (tool === 'inspect_package') {
        const raw = await safeReadFile(sourceDir, 'package.json', 512 * 1024);
        const pkg = JSON.parse(raw);
        out.push({ tool, ok: true, package: { name: pkg.name || '', version: pkg.version || '', type: pkg.type || '', engines: pkg.engines || {}, scripts: pkg.scripts || {}, dependencies: Object.keys(pkg.dependencies || {}).slice(0, 120), devDependencies: Object.keys(pkg.devDependencies || {}).slice(0, 120) } });
      } else if (tool === 'inspect_compose') {
        const candidates = ['solohost/docker-compose.yml','docker-compose.yml','compose.yml','compose.yaml'];
        let found = null;
        for (const c of candidates) {
          const text = await safeReadFile(sourceDir, c).catch(() => '');
          if (text.trim()) { found = { path: c, content: text.slice(0, 18000) }; break; }
        }
        out.push({ tool, ok: Boolean(found), compose: found });
      } else if (tool === 'inspect_config_options') {
        const candidates = ['solohost/config_options.yml','config_options.yml'];
        let found = null;
        for (const c of candidates) {
          const text = await safeReadFile(sourceDir, c).catch(() => '');
          if (text.trim()) { found = { path: c, content: text.slice(0, 18000) }; break; }
        }
        out.push({ tool, ok: Boolean(found), config: found });
      } else {
        out.push({ tool, ok: false, error: 'Tool is not available in Upgrade scope.' });
      }
    } catch (err) {
      out.push({ tool, ok: false, error: String(err.message || err).slice(0, 500) });
    }
  }
  return out;
}
