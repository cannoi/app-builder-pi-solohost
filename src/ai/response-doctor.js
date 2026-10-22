/**
 * Deterministic AI response repair/salvage — no invented content.
 */
import { extractJson } from '../utils/validate.js';

const FILE_BLOCK_RE = /<<<FILE\s+path="([^"]+)"\s*>>>\r?\n?([\s\S]*?)<<<END FILE>>>/gi;
const NOTES_BLOCK_RE = /<<<NOTES>>>\r?\n?([\s\S]*?)<<<END NOTES>>>/i;

export function parseFileBlocks(text = '') {
  const files = [];
  let m;
  const re = new RegExp(FILE_BLOCK_RE.source, 'gi');
  while ((m = re.exec(text)) !== null) {
    const path = String(m[1] || '').replace(/^\/+/, '').trim();
    if (!path || path.includes('..') || path.startsWith('/')) continue;
    files.push({ path, content: m[2] ?? '' });
  }
  const notesM = text.match(NOTES_BLOCK_RE);
  return { files, notes: notesM ? notesM[1].trim() : '' };
}

function stripPreamble(text) {
  let t = String(text || '');
  t = t.replace(/^\uFEFF/, '');
  t = t.replace(/[\u200B-\u200D\uFEFF]/g, '');
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, '');
  t = t.replace(/^(here (is|are) (the )?(json|files|code)[:\s]*)/i, '');
  return t.trim();
}

function repairJsonText(s) {
  let t = String(s || '');
  // trailing commas
  t = t.replace(/,\s*([\]}])/g, '$1');
  // smart quotes outside (rough)
  t = t.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
  // JS/Python literals
  t = t.replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null');
  t = t.replace(/\bundefined\b/g, 'null').replace(/\bNaN\b/g, 'null');
  // comments outside strings (simple)
  t = t.replace(/\/\/[^\n]*/g, '');
  t = t.replace(/\/\*[\s\S]*?\*\//g, '');
  return t;
}

function salvageTruncatedJson(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let s = text.slice(start);
  // Try close open structures
  const opens = (s.match(/\{/g) || []).length;
  const closes = (s.match(/\}/g) || []).length;
  const aOpen = (s.match(/\[/g) || []).length;
  const aClose = (s.match(/\]/g) || []).length;
  // truncate to last complete file object in files array if possible
  const filesIdx = s.search(/"files"\s*:\s*\[/);
  if (filesIdx >= 0) {
    const after = s.slice(filesIdx);
    // find complete {"path":...} objects
    const fileObjs = [];
    const objRe = /\{\s*"path"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"\s*,\s*"content"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/g;
    let m;
    while ((m = objRe.exec(after)) !== null) {
      try {
        const path = JSON.parse(`"${m[1]}"`);
        const content = JSON.parse(`"${m[2]}"`);
        fileObjs.push({ path, content });
      } catch { /* skip incomplete */ }
    }
    if (fileObjs.length) {
      return { files: fileObjs, salvaged: true, complete: fileObjs.length };
    }
  }
  // balance braces
  let balanced = s;
  for (let i = 0; i < opens - closes; i++) balanced += '}';
  for (let i = 0; i < aOpen - aClose; i++) balanced += ']';
  try {
    return JSON.parse(balanced);
  } catch {
    return null;
  }
}

function normalizeShape(value) {
  if (!value || typeof value !== 'object') return value;
  let v = value;
  if (v.app?.files) v = v.app;
  if (v.result?.files) v = v.result;
  if (v.data?.files) v = v.data;
  if (v.files && !Array.isArray(v.files) && typeof v.files === 'object') {
    v = {
      ...v,
      files: Object.entries(v.files).map(([path, content]) => ({
        path,
        content: typeof content === 'string' ? content : (content?.content || content?.code || ''),
      })),
    };
  }
  if (Array.isArray(v.files)) {
    v.files = v.files.map((f) => {
      if (!f || typeof f !== 'object') return null;
      const path = f.path || f.file || f.filename || f.name || f.filepath;
      let content = f.content ?? f.code ?? f.text ?? f.source ?? f.body;
      if (Array.isArray(content)) content = content.join('\n');
      if (!path || content == null) return null;
      return { path: String(path).replace(/^\/+/, ''), content: String(content) };
    }).filter(Boolean);
  }
  return v;
}

/**
 * @param {string} text
 * @param {{ expect?: 'files'|'json' }} opts
 */
export function parseAiOutput(text, { expect = 'json' } = {}) {
  const trace = [];
  let raw = stripPreamble(text);
  trace.push('normalize');

  // File-block protocol first when expecting files
  if (expect === 'files' || /<<<FILE\s+path=/i.test(raw)) {
    const blocks = parseFileBlocks(raw);
    if (blocks.files.length) {
      trace.push(`file-blocks:${blocks.files.length}`);
      return {
        ok: true,
        value: { files: blocks.files, notes: blocks.notes },
        repaired: ['file-blocks'],
        salvaged: null,
        issues: [],
        parseTrace: trace,
        protocol: 'file-blocks',
      };
    }
  }

  // Fenced json
  const fence = raw.match(/```(?:json|javascript)?\s*([\s\S]*?)```/i);
  if (fence) {
    raw = fence[1].trim();
    trace.push('unwrap-fence');
  }

  let value = null;
  let repaired = [];
  let salvaged = null;

  try {
    value = JSON.parse(raw);
    trace.push('strict-parse');
  } catch {
    try {
      value = extractJson(raw);
      if (value) trace.push('extractJson');
    } catch { /* */ }
  }

  if (!value) {
    const repairedText = repairJsonText(raw);
    try {
      value = JSON.parse(repairedText);
      repaired.push('json-repair');
      trace.push('json-repair');
    } catch {
      const salv = salvageTruncatedJson(repairedText);
      if (salv?.files?.length) {
        value = salv;
        salvaged = { complete: salv.complete || salv.files.length, truncatedLast: true };
        repaired.push('truncation-salvage');
        trace.push('salvage');
      }
    }
  }

  if (!value) {
    return {
      ok: false,
      value: null,
      repaired,
      salvaged,
      issues: ['unparseable'],
      parseTrace: trace,
      class: 'FORMAT',
    };
  }

  value = normalizeShape(value);
  if (expect === 'files' && (!value.files || !value.files.length)) {
    return {
      ok: false,
      value,
      repaired,
      salvaged,
      issues: ['no-files'],
      parseTrace: trace,
      class: 'SCHEMA_MISMATCH',
    };
  }

  // Drop empty / placeholder-only
  if (Array.isArray(value.files)) {
    const before = value.files.length;
    value.files = value.files.filter((f) => {
      const c = String(f.content || '').trim();
      if (!c) return false;
      if (/^\/\/\s*TODO implement\s*$/i.test(c)) return false;
      return true;
    });
    if (value.files.length < before) repaired.push('drop-empty');
  }

  return {
    ok: true,
    value,
    repaired,
    salvaged,
    issues: [],
    parseTrace: trace,
    protocol: 'json',
  };
}

export function doctorCompleteJson(text) {
  return parseAiOutput(text, { expect: 'json' });
}

export function doctorCompleteFiles(text) {
  return parseAiOutput(text, { expect: 'files' });
}
