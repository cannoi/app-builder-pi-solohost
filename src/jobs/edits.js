/**
 * Anchored search/replace edits (Release D1).
 *
 * The AI may answer a change request with
 *   { "edits": [ { "path": "server.js", "search": "exact existing text", "replace": "new text" } ],
 *     "new_files": [ { "path": "lan.js", "content": "..." } ] }
 * instead of re-sending whole files. Rules:
 *   - `search` must match EXACTLY ONCE in the file as it is at that moment (earlier edits of the same file apply first);
 *   - the batch is atomic: if any edit fails nothing is returned as a file and the errors (with a snippet of the
 *     closest text) go back to the AI so it can correct itself;
 *   - CRLF files keep their line endings; matching is done on LF-normalized text.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

function toLf(s) { return String(s).replace(/\r\n/g, '\n'); }

function closestSnippet(text, search) {
  const probe = toLf(search).split('\n').map((l) => l.trim()).find((l) => l.length >= 6) || toLf(search).trim().slice(0, 40);
  if (!probe) return '';
  const lines = toLf(text).split('\n');
  const needle = probe.slice(0, 40);
  const idx = lines.findIndex((l) => l.includes(needle));
  if (idx < 0) return '';
  return lines.slice(Math.max(0, idx - 1), idx + 3).join('\n').slice(0, 400);
}

function countOccurrences(text, search) {
  if (!search) return 0;
  let n = 0;
  let pos = 0;
  while ((pos = text.indexOf(search, pos)) !== -1) { n += 1; pos += Math.max(1, search.length); if (n > 5) break; }
  return n;
}

/**
 * @param {{ sourceDir: string, edits: Array<{path:string, search:string, replace:string}>, readFile?: (rel:string)=>Promise<string|null> }} opts
 * @returns {Promise<{ ok: boolean, files: Array<{path:string, content:string}>, errors: Array<{path:string, index:number, reason:string, detail:string, snippet?:string}> }>}
 */
export async function applyEdits({ sourceDir, edits = [], readFile = null } = {}) {
  const read = readFile || (async (rel) => fs.readFile(path.join(sourceDir, rel), 'utf8').catch(() => null));
  const working = new Map(); // rel -> { content (LF), crlf }
  const errors = [];
  let index = -1;
  for (const e of Array.isArray(edits) ? edits : []) {
    index += 1;
    const rel = String(e?.path || '').replace(/\\/g, '/').replace(/^\.?\/+/, '');
    if (!rel || rel.includes('..')) { errors.push({ path: rel || '(empty)', index, reason: 'bad_path', detail: 'Edit path is empty or unsafe.' }); continue; }
    if (typeof e.search !== 'string' || !e.search.length) { errors.push({ path: rel, index, reason: 'empty_search', detail: 'Edit has no "search" text. Use new_files to create a file or send the whole file for an explicit rewrite.' }); continue; }
    if (typeof e.replace !== 'string') { errors.push({ path: rel, index, reason: 'bad_replace', detail: 'Edit has no "replace" string.' }); continue; }
    if (!working.has(rel)) {
      const raw = await read(rel);
      if (raw == null) { errors.push({ path: rel, index, reason: 'file_missing', detail: `File "${rel}" does not exist. Use new_files for new files.` }); continue; }
      working.set(rel, { content: toLf(raw), crlf: /\r\n/.test(raw) });
    }
    const w = working.get(rel);
    const search = toLf(e.search);
    const n = countOccurrences(w.content, search);
    if (n === 0) {
      errors.push({ path: rel, index, reason: 'not_found', detail: 'The "search" text was not found exactly. Copy it verbatim from the file.', snippet: closestSnippet(w.content, search) });
      continue;
    }
    if (n > 1) {
      errors.push({ path: rel, index, reason: 'ambiguous', detail: `The "search" text occurs ${n}+ times. Include more surrounding lines so it matches exactly once.` });
      continue;
    }
    w.content = w.content.replace(search, () => toLf(e.replace));
  }
  if (errors.length) return { ok: false, files: [], errors };
  const files = [...working.entries()].map(([rel, w]) => ({ path: rel, content: w.crlf ? w.content.replace(/\n/g, '\r\n') : w.content }));
  return { ok: true, files, errors: [] };
}

/** Human/AI readable feedback for failed edits (goes back into the next prompt). */
export function describeEditErrors(errors = []) {
  return errors.slice(0, 6).map((e) => `- ${e.path} (edit #${e.index + 1}): ${e.reason} — ${e.detail}${e.snippet ? `\n  closest text in file:\n${e.snippet.split('\n').map((l) => '    ' + l).join('\n')}` : ''}`).join('\n');
}

export default { applyEdits, describeEditErrors };
