/**
 * Anchored search/replace edits.
 * search must resolve to exactly one location (after optional whitespace-flexible match).
 * Batch is atomic: any hard failure → no files returned (errors go back to AI).
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

function allOccurrenceSnippets(text, search, limit = 3) {
  const t = toLf(text);
  const s = toLf(search);
  const lines = t.split('\n');
  const out = [];
  let pos = 0;
  while (out.length < limit) {
    const i = t.indexOf(s, pos);
    if (i < 0) break;
    // map char index → line
    let char = 0;
    let lineIdx = 0;
    for (; lineIdx < lines.length; lineIdx++) {
      const next = char + lines[lineIdx].length + 1;
      if (i < next) break;
      char = next;
    }
    const snip = lines.slice(Math.max(0, lineIdx - 1), lineIdx + 3).join('\n').slice(0, 280);
    out.push({ index: out.length + 1, atLine: lineIdx + 1, snippet: snip });
    pos = i + Math.max(1, s.length);
  }
  return out;
}

function countOccurrences(text, search) {
  if (!search) return 0;
  let n = 0;
  let pos = 0;
  while ((pos = text.indexOf(search, pos)) !== -1) {
    n += 1;
    pos += Math.max(1, search.length);
    if (n > 8) break;
  }
  return n;
}

/** Collapse runs of spaces/tabs but keep newlines (helps AI drift on indentation). */
function softNormalize(s) {
  return toLf(s).replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n');
}

/**
 * Find a unique match for `search` in `content`.
 * Tries: exact → soft whitespace normalize → line-trimmed block match.
 * @returns {{ ok: true, content: string, mode: string } | { ok: false, reason: string, n?: number, snippets?: object[] }}
 */
export function resolveSearch(content, search) {
  const text = toLf(content);
  const needle = toLf(search);
  if (!needle.length) return { ok: false, reason: 'empty_search' };

  const exactN = countOccurrences(text, needle);
  if (exactN === 1) {
    return {
      ok: true,
      mode: 'exact',
      apply: (repl) => text.replace(needle, () => toLf(repl)),
    };
  }
  if (exactN > 1) {
    return {
      ok: false,
      reason: 'ambiguous',
      n: exactN,
      snippets: allOccurrenceSnippets(text, needle),
    };
  }

  // Line-trimmed: unique consecutive line sequence (tolerates indentation drift)
  const lineHit = matchTrimmedLines(text, needle);
  if (lineHit.ok) {
    return {
      ok: true,
      mode: 'line-trim',
      apply: (repl) => applyLineTrimReplace(text, needle, toLf(repl)),
    };
  }
  if (lineHit.n > 1) {
    return { ok: false, reason: 'ambiguous', n: lineHit.n, snippets: lineHit.snippets || [] };
  }

  // Soft whitespace on single-line or short needles
  const normText = softNormalize(text);
  const normNeedle = softNormalize(needle);
  if (normNeedle.length >= 8 && !normNeedle.includes('\n')) {
    const softN = countOccurrences(normText, normNeedle);
    if (softN === 1) {
      // Character-level: replace first soft occurrence by scanning original with flexible spaces
      return {
        ok: true,
        mode: 'soft-single',
        apply: (repl) => applySoftSingleLine(text, needle, toLf(repl)),
      };
    }
    if (softN > 1) {
      return {
        ok: false,
        reason: 'ambiguous',
        n: softN,
        detail: 'Multiple matches after whitespace normalization. Expand search with unique surrounding lines.',
      };
    }
  }

  return { ok: false, reason: 'not_found', snippet: closestSnippet(text, needle) };
}

function applySoftSingleLine(text, search, replace) {
  const normNeedle = softNormalize(search).trim();
  const lines = toLf(text).split('\n');
  let hit = -1;
  for (let i = 0; i < lines.length; i++) {
    if (softNormalize(lines[i]).trim() === normNeedle) {
      if (hit >= 0) return text; // ambiguous
      hit = i;
    }
  }
  if (hit < 0) {
    // whole-text soft replace once
    const nt = softNormalize(text);
    const idx = nt.indexOf(normNeedle);
    if (idx < 0 || nt.indexOf(normNeedle, idx + 1) >= 0) return text;
    // fall back: cannot map reliably — return unchanged
    return text;
  }
  lines[hit] = replace;
  return lines.join('\n');
}

function matchTrimmedLines(text, search) {
  const textLines = toLf(text).split('\n');
  const searchLines = toLf(search).split('\n').map((l) => l.trimEnd());
  // drop leading/trailing empty from search
  while (searchLines.length && searchLines[0].trim() === '') searchLines.shift();
  while (searchLines.length && searchLines[searchLines.length - 1].trim() === '') searchLines.pop();
  if (!searchLines.length) return { ok: false, n: 0 };

  const targets = searchLines.map((l) => l.trim());
  const hits = [];
  for (let i = 0; i <= textLines.length - targets.length; i++) {
    let ok = true;
    for (let j = 0; j < targets.length; j++) {
      if (textLines[i + j].trim() !== targets[j]) { ok = false; break; }
    }
    if (ok) hits.push(i);
    if (hits.length > 5) break;
  }
  if (hits.length === 1) return { ok: true, startLine: hits[0], lineCount: targets.length };
  if (hits.length > 1) {
    return {
      ok: false,
      n: hits.length,
      snippets: hits.slice(0, 3).map((h, idx) => ({
        index: idx + 1,
        atLine: h + 1,
        snippet: textLines.slice(h, h + targets.length + 1).join('\n').slice(0, 280),
      })),
    };
  }
  return { ok: false, n: 0 };
}

function applyLineTrimReplace(text, search, replace) {
  const textLines = toLf(text).split('\n');
  const searchLines = toLf(search).split('\n').map((l) => l.trimEnd());
  while (searchLines.length && searchLines[0].trim() === '') searchLines.shift();
  while (searchLines.length && searchLines[searchLines.length - 1].trim() === '') searchLines.pop();
  const targets = searchLines.map((l) => l.trim());
  for (let i = 0; i <= textLines.length - targets.length; i++) {
    let ok = true;
    for (let j = 0; j < targets.length; j++) {
      if (textLines[i + j].trim() !== targets[j]) { ok = false; break; }
    }
    if (ok) {
      const replLines = toLf(replace).split('\n');
      textLines.splice(i, targets.length, ...replLines);
      return textLines.join('\n');
    }
  }
  return text;
}

/**
 * Soft-replace: find unique soft-normalized match by sliding window on lines.
 */
function applySoftReplace(text, search, replace) {
  const textLines = toLf(text).split('\n');
  const searchLines = toLf(search).split('\n');
  const normSearch = searchLines.map((l) => l.replace(/[ \t]+/g, ' ').trimEnd()).join('\n');
  const hits = [];
  for (let i = 0; i <= textLines.length - searchLines.length; i++) {
    const window = textLines.slice(i, i + searchLines.length).map((l) => l.replace(/[ \t]+/g, ' ').trimEnd()).join('\n');
    if (window === normSearch) hits.push(i);
    if (hits.length > 3) break;
  }
  if (hits.length !== 1) return text;
  const replLines = toLf(replace).split('\n');
  textLines.splice(hits[0], searchLines.length, ...replLines);
  return textLines.join('\n');
}

/**
 * @returns {Promise<{ ok: boolean, files: Array<{path:string, content:string}>, errors: Array<object> }>}
 */
export async function applyEdits({ sourceDir, edits = [], readFile = null } = {}) {
  const read = readFile || (async (rel) => fs.readFile(path.join(sourceDir, rel), 'utf8').catch(() => null));
  const working = new Map();
  const errors = [];
  let index = -1;

  for (const e of Array.isArray(edits) ? edits : []) {
    index += 1;
    const rel = String(e?.path || '').replace(/\\/g, '/').replace(/^\.?\/+/, '');
    if (!rel || rel.includes('..')) {
      errors.push({ path: rel || '(empty)', index, reason: 'bad_path', detail: 'Edit path is empty or unsafe.' });
      continue;
    }
    if (typeof e.search !== 'string' || !e.search.length) {
      errors.push({ path: rel, index, reason: 'empty_search', detail: 'Edit has no "search" text. Use new_files to create a file or send the whole file for an explicit rewrite.' });
      continue;
    }
    if (!working.has(rel)) {
      const raw = await read(rel);
      if (raw == null) {
        errors.push({ path: rel, index, reason: 'file_missing', detail: `File "${rel}" does not exist. Use new_files for new files.` });
        continue;
      }
      working.set(rel, { content: toLf(raw), crlf: /\r\n/.test(raw) });
    }
    const w = working.get(rel);
    if (!w) continue;

    const resolved = resolveSearch(w.content, e.search);
    if (!resolved.ok) {
      if (resolved.reason === 'ambiguous') {
        const snips = (resolved.snippets || []).map((s) =>
          `  match #${s.index} near line ${s.atLine}:\n${String(s.snippet || '').split('\n').map((l) => '    ' + l).join('\n')}`
        ).join('\n');
        errors.push({
          path: rel,
          index,
          reason: 'ambiguous',
          detail: resolved.detail || `The "search" text occurs ${resolved.n || '2'}+ times. Include more surrounding lines so it matches exactly once.`,
          snippet: snips || closestSnippet(w.content, e.search),
        });
      } else if (resolved.reason === 'not_found') {
        errors.push({
          path: rel,
          index,
          reason: 'not_found',
          detail: 'The "search" text was not found exactly. Copy it verbatim from the file (or use a unique multi-line block).',
          snippet: resolved.snippet || closestSnippet(w.content, e.search),
        });
      } else {
        errors.push({ path: rel, index, reason: resolved.reason || 'failed', detail: resolved.detail || 'Edit could not be applied.' });
      }
      continue;
    }

    if (typeof resolved.apply === 'function') {
      w.content = resolved.apply(e.replace ?? '');
    } else {
      const search = toLf(e.search);
      w.content = w.content.replace(search, () => toLf(e.replace ?? ''));
    }
  }

  if (errors.length) return { ok: false, files: [], errors };
  const files = [...working.entries()].map(([rel, w]) => ({
    path: rel,
    content: w.crlf ? w.content.replace(/\n/g, '\r\n') : w.content,
  }));
  return { ok: true, files, errors: [] };
}

export function describeEditErrors(errors = []) {
  return errors.slice(0, 6).map((e) => {
    const snip = e.snippet
      ? `\n  context in file:\n${String(e.snippet).split('\n').map((l) => (l.startsWith('  ') ? l : '    ' + l)).join('\n')}`
      : '';
    return `- ${e.path} (edit #${e.index + 1}): ${e.reason} — ${e.detail}${snip}`;
  }).join('\n');
}

export default { applyEdits, describeEditErrors, resolveSearch };
