/**
 * Change Engine V2 — pure search/replace edit applier (no network I/O).
 * Atomic in-memory apply; write only when all edits valid.
 */
import path from 'node:path';

export const MAX_FILES = 24;
export const MAX_BYTES = 6 * 1024 * 1024;
const BLOCKED = ['.env', 'node_modules', '.git'];
const SECRET_NAMES = [/\.pem$/i, /\.key$/i, /id_rsa/i, /secrets?\./i];

export function normalizeLf(s) {
  return String(s ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function isUnsafePath(rel) {
  const p = String(rel || '').replace(/\\/g, '/');
  if (!p || p.startsWith('/') || p.includes('..')) return true;
  const lower = p.toLowerCase();
  if (BLOCKED.some((b) => lower === b || lower.startsWith(b + '/'))) return true;
  if (SECRET_NAMES.some((re) => re.test(p))) return true;
  if (/(^|\/)\.env(\.|$)/i.test(p)) return true;
  return false;
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  while (true) {
    const j = haystack.indexOf(needle, i);
    if (j < 0) break;
    n += 1;
    i = j + needle.length;
  }
  return n;
}

function nearestSnippet(content, search, radius = 120) {
  const s = normalizeLf(search).trim();
  if (!s) return content.slice(0, radius);
  const lines = content.split('\n');
  const key = s.split('\n')[0].trim();
  let best = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(key.slice(0, Math.min(40, key.length)))) {
      best = i;
      break;
    }
  }
  const from = Math.max(0, best - 2);
  const to = Math.min(lines.length, best + 6);
  return lines.slice(from, to).join('\n').slice(0, radius * 2);
}

/**
 * Try exact match, then trim trailing/leading whitespace per line of search block.
 * @returns {{ ok:true, content:string } | { ok:false, error:string, nearest?:string }}
 */
export function applyReplace(content, search, replace) {
  const src = normalizeLf(content);
  const exact = normalizeLf(search);
  const repl = normalizeLf(replace);

  const tryOnce = (needle) => {
    const n = countOccurrences(src, needle);
    if (n === 1) return { ok: true, content: src.replace(needle, repl) };
    if (n === 0) return { ok: false, reason: 'zero' };
    return { ok: false, reason: 'many', count: n };
  };

  let r = tryOnce(exact);
  if (r.ok) return r;

  // Trim trailing spaces on each line of the search block
  const trimmed = exact.split('\n').map((l) => l.replace(/[ \t]+$/g, '')).join('\n').trim();
  if (trimmed && trimmed !== exact) {
    r = tryOnce(trimmed);
    if (r.ok) return r;
  }

  // Soft: collapse runs of spaces inside a single-line search
  if (!exact.includes('\n')) {
    const soft = exact.trim().replace(/[ \t]+/g, ' ');
    const softSrc = src.replace(/[ \t]+/g, ' ');
    // only if unique soft match maps to unique region — conservative: skip if multi
    if (soft && countOccurrences(softSrc, soft) === 1) {
      // find original span approximately by first non-ws token
      const token = soft.split(' ')[0];
      const idx = src.indexOf(token);
      if (idx >= 0 && countOccurrences(src, exact.trim()) === 1) {
        return { ok: true, content: src.replace(exact.trim(), repl.trim()) };
      }
    }
  }

  if (r.reason === 'many') {
    return {
      ok: false,
      error: `search matched ${r.count} times; must match exactly once`,
      nearest: nearestSnippet(src, exact),
    };
  }
  return {
    ok: false,
    error: 'search matched 0 times',
    nearest: nearestSnippet(src, exact),
  };
}

/**
 * Apply edits against a virtual file map { path: content string }.
 * Does not write disk. Returns new map or error.
 */
export function applyEditsInMemory(fileMap, edits, { maxFiles = MAX_FILES, maxBytes = MAX_BYTES } = {}) {
  const map = { ...fileMap };
  const list = Array.isArray(edits) ? edits : [];
  if (list.length > maxFiles) {
    return { ok: false, error: `too many edits (${list.length} > ${maxFiles})` };
  }
  let totalBytes = Object.values(map).reduce((a, c) => a + Buffer.byteLength(String(c || ''), 'utf8'), 0);
  const touched = [];

  for (const raw of list) {
    const rel = String(raw?.path || '').replace(/\\/g, '/').replace(/^\.\//, '');
    if (isUnsafePath(rel)) {
      return { ok: false, error: `unsafe path blocked: ${rel}` };
    }
    const op = String(raw?.op || 'replace').toLowerCase();

    if (op === 'delete') {
      if (!(rel in map) && map[rel] === undefined) {
        // allow delete of existing only
        if (!(rel in fileMap)) return { ok: false, error: `cannot delete missing file: ${rel}` };
      }
      const content = map[rel] ?? '';
      if (/paf-made-by/.test(content)) {
        return { ok: false, error: `refusing to delete file containing paf-made-by badge: ${rel}` };
      }
      delete map[rel];
      touched.push(rel);
      continue;
    }

    if (op === 'create') {
      if (rel in map && map[rel] != null) {
        const lines = String(map[rel]).split('\n').length;
        if (lines > 200) {
          return { ok: false, error: `create refused: ${rel} already exists and is >200 lines; use replace` };
        }
        // allow full overwrite for small files
      }
      const content = normalizeLf(raw?.replace ?? raw?.content ?? '');
      const bytes = Buffer.byteLength(content, 'utf8');
      if (totalBytes + bytes > maxBytes) return { ok: false, error: 'total content exceeds 6MB' };
      map[rel] = content;
      totalBytes += bytes;
      touched.push(rel);
      continue;
    }

    // replace
    const existing = map[rel];
    if (existing == null) {
      return { ok: false, error: `replace target missing: ${rel}`, nearest: '' };
    }
    if (raw?.search == null || raw?.search === '') {
      // full file replace only if <200 lines
      if (String(existing).split('\n').length > 200) {
        return { ok: false, error: `full-file replace refused for ${rel} (>200 lines); provide search` };
      }
      const content = normalizeLf(raw?.replace ?? raw?.content ?? '');
      map[rel] = content;
      touched.push(rel);
      continue;
    }
    const result = applyReplace(existing, raw.search, raw.replace ?? '');
    if (!result.ok) {
      return {
        ok: false,
        error: `${rel}: ${result.error}`,
        nearest: result.nearest,
        path: rel,
      };
    }
    // preserve paf-made-by if somehow stripped
    if (/paf-made-by/.test(existing) && !/paf-made-by/.test(result.content)) {
      return { ok: false, error: `edit would remove paf-made-by badge in ${rel}` };
    }
    map[rel] = result.content;
    touched.push(rel);
  }

  return { ok: true, files: map, touched: [...new Set(touched)] };
}

/**
 * Read paths from disk into map via provided readFile(fn).
 */
export async function loadFiles(readFile, paths) {
  const map = {};
  for (const rel of paths) {
    if (isUnsafePath(rel)) continue;
    try {
      map[rel] = await readFile(rel);
    } catch {
      // missing ok for create
    }
  }
  return map;
}

/**
 * Write map diffs to disk via writeFile / unlink. Atomic: caller should only call after applyEditsInMemory ok.
 */
export async function commitFiles({ readFile, writeFile, unlink, beforeMap, afterMap, touched }) {
  for (const rel of touched) {
    if (!(rel in afterMap)) {
      if (unlink) await unlink(rel);
      continue;
    }
    await writeFile(rel, afterMap[rel]);
  }
  return { written: touched.filter((p) => p in afterMap), deleted: touched.filter((p) => !(p in afterMap)) };
}

export default { applyEditsInMemory, applyReplace, isUnsafePath, normalizeLf, loadFiles, commitFiles, MAX_FILES, MAX_BYTES };
