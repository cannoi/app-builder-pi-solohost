import path from 'node:path';
import fs from 'node:fs/promises';
import { listFiles } from '../utils/fsx.js';

const NEW_FILE_EXT = /\.(?:js|mjs|cjs|ts|tsx|jsx|json|html|css|md|txt|svg|yml|yaml|py|sql)$/i;
const PROTECTED = /^(?:\.env$|\.git\/|node_modules\/|(?:data|workspace|projects)\/)/i;

function normalize(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.?\/+/, '');
}

/**
 * Validate the paths of an AI patch before anything is written.
 *
 *  - traversal / absolute / protected paths are always rejected;
 *  - existing files are accepted;
 *  - files declared by the AI as new (`allowedNew`) are accepted;
 *  - otherwise a NEW file is accepted only when it looks intentional: it is not a look-alike of an existing
 *    file elsewhere (e.g. `src/server.js` while `server.js` exists -> almost certainly a hallucinated path),
 *    has a source/config extension, is at most 3 folders deep, and the number of new files stays small.
 *
 * @returns {{ ok: boolean, files: object[], rejected: string[], created: string[], didYouMean: Record<string,string>, suggestion: string }}
 */
export async function filterPatchFiles({ sourceDir, files = [], allowedNew = [], maxNew = 6, allowImplicitNew = true } = {}) {
  const allowedNewSet = new Set((allowedNew || []).map(normalize));
  const accepted = [];
  const rejected = [];
  const created = [];
  const didYouMean = {};
  const root = path.resolve(sourceDir);

  let existing = [];
  try { existing = (await listFiles(root)).map(normalize); } catch { existing = []; }
  const existingSet = new Set(existing);
  const byBase = new Map();
  for (const rel of existing) {
    const base = rel.split('/').pop().toLowerCase();
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(rel);
  }

  for (const f of files || []) {
    const rel = normalize(f?.path || f?.file);
    if (!rel || rel.includes('..') || path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) { rejected.push(rel || '(empty)'); continue; }
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(root + path.sep)) { rejected.push(rel); continue; }
    if (PROTECTED.test(rel)) { rejected.push(rel); continue; }

    let exists = existingSet.has(rel);
    if (!exists) {
      try { await fs.access(abs); exists = true; } catch { exists = false; }
    }
    if (exists) { accepted.push({ ...f, path: rel }); continue; }
    if (allowedNewSet.has(rel)) { accepted.push({ ...f, path: rel }); created.push(rel); continue; }

    // Look-alike of an existing file in another folder -> hallucinated path, suggest the real one.
    const base = rel.split('/').pop().toLowerCase();
    const twins = (byBase.get(base) || []).filter((p) => p !== rel);
    if (twins.length) { rejected.push(rel); didYouMean[rel] = twins[0]; continue; }

    const depth = rel.split('/').length - 1;
    if (allowImplicitNew && NEW_FILE_EXT.test(rel) && depth <= 3 && created.length < maxNew) {
      accepted.push({ ...f, path: rel });
      created.push(rel);
      continue;
    }
    rejected.push(rel);
  }

  const hints = Object.entries(didYouMean).map(([bad, good]) => `"${bad}" does not exist - did you mean "${good}"?`);
  return {
    ok: rejected.length === 0,
    files: accepted,
    rejected,
    created,
    didYouMean,
    suggestion: rejected.length
      ? `${hints.length ? hints.join(' ') + ' ' : ''}Path(s) not allowed or missing: ${rejected.slice(0, 5).join(', ')}. Use existing project paths, or declare genuinely new files in "new_files".`
      : '',
  };
}


/**
 * Prefer existing real paths when AI invents a twin path (e.g. src/server.js vs server.js).
 * Returns files ready to write + notes for the AI.
 */
export async function remapAndFilterPatchFiles(opts = {}) {
  const first = await filterPatchFiles(opts);
  if (!first.rejected.length || !Object.keys(first.didYouMean || {}).length) return first;

  const byPath = new Map();
  for (const f of first.files) byPath.set(String(f.path).replace(/\\/g, '/'), f);

  const remapped = [];
  const stillRejected = [];
  for (const bad of first.rejected) {
    const good = first.didYouMean[bad];
    if (!good) { stillRejected.push(bad); continue; }
    const original = (opts.files || []).find((f) => String(f?.path || f?.file || '').replace(/\\/g, '/').replace(/^\.\/?/, '') === bad);
    if (!original || typeof original.content !== 'string') { stillRejected.push(bad); continue; }
    if (byPath.has(good)) {
      // Prefer explicit existing-path edit; drop hallucinated twin
      remapped.push({ from: bad, to: good, skipped: true });
      continue;
    }
    const next = { ...original, path: good };
    byPath.set(good, next);
    remapped.push({ from: bad, to: good });
  }

  const files = [...byPath.values()];
  const notes = remapped.map((r) => r.skipped
    ? `Ignored hallucinated path "${r.from}" (already editing "${r.to}").`
    : `Remapped "${r.from}" → "${r.to}" (file that exists in the project).`);
  return {
    ok: stillRejected.length === 0 && files.length > 0,
    files,
    rejected: stillRejected,
    created: first.created,
    didYouMean: first.didYouMean,
    remapped,
    suggestion: stillRejected.length
      ? `${notes.join(' ')} Still invalid: ${stillRejected.slice(0, 5).join(', ')}. Use paths from FILE INVENTORY only.`
      : notes.join(' '),
  };
}
