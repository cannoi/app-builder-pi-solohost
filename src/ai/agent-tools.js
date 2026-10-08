import fs from 'node:fs/promises';
import path from 'node:path';
import { listFiles } from '../utils/fsx.js';

const SKIP = /(^|\/)(node_modules|\.git|dist|build|coverage|\.next|vendor)(\/|$)/i;

function safeRel(value) {
  const rel = String(value || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (!rel || rel.startsWith('/') || rel.includes('..')) throw new Error(`Unsafe path: ${rel}`);
  return rel;
}

export async function runAgentTools({ sourceDir, actions = [] } = {}) {
  const out = [];
  for (const action of Array.isArray(actions) ? actions.slice(0, 8) : []) {
    const tool = String(action?.tool || '').trim();
    try {
      if (tool === 'list_files') {
        const files = (await listFiles(sourceDir)).filter((f) => !SKIP.test(f));
        out.push({ tool, ok: true, files: files.slice(0, 300) });
      } else if (tool === 'search_text') {
        const query = String(action.query || '').trim();
        if (!query) throw new Error('search_text requires query');
        const files = (await listFiles(sourceDir)).filter((f) => !SKIP.test(f)).slice(0, 500);
        const matches = [];
        for (const rel of files) {
          const full = path.join(sourceDir, rel);
          const text = await fs.readFile(full, 'utf8').catch(() => '');
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
        const full = path.join(sourceDir, rel);
        const text = await fs.readFile(full, 'utf8');
        const lines = text.split(/\r?\n/);
        const start = Math.max(1, Number(action.startLine || 1));
        const end = Math.min(lines.length, Number(action.endLine || (tool === 'read_file' ? lines.length : start + 180)));
        out.push({ tool, ok: true, path: rel, content: lines.slice(start - 1, end).join('\n').slice(0, 14000), startLine: start, endLine: end });
      } else if (tool === 'inspect_compose') {
        const candidates = ['solohost/docker-compose.yml','docker-compose.yml','compose.yml','compose.yaml'];
        let found = null;
        for (const c of candidates) {
          const text = await fs.readFile(path.join(sourceDir, c), 'utf8').catch(() => '');
          if (text.trim()) { found = { path: c, content: text.slice(0, 18000) }; break; }
        }
        out.push({ tool, ok: Boolean(found), compose: found });
      } else if (tool === 'inspect_config_options') {
        const candidates = ['solohost/config_options.yml','config_options.yml'];
        let found = null;
        for (const c of candidates) {
          const text = await fs.readFile(path.join(sourceDir, c), 'utf8').catch(() => '');
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
