/**
 * Response Doctor (Release D3) — deterministic, dependency-free repair of AI answers.
 *
 * Rules:
 *  - NEVER invents code. It only normalizes, repairs syntax, or salvages what the model already produced.
 *  - String-aware: repairs never touch characters that are inside a JSON string value
 *    (so file contents such as `// comment`, `'quotes'` or `{ a: 1 }` are preserved byte-for-byte).
 *  - Every step is recorded in a trace so callers/AI Doctor can explain what happened.
 */

const FENCE_RE = /```[a-zA-Z0-9_-]*[ \t]*\r?\n?/g;

/** Strip BOM, zero-width chars, reasoning tags and (outside of string values) smart quotes. */
export function normalizeRaw(text = '') {
  let s = String(text ?? '');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  s = s.replace(/[\u200B\u200C\u200D\u2060]/g, '');
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '');
  s = s.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
  return s.trim();
}

/** Remove markdown fences without touching the content between them. */
function stripFences(s) {
  if (!s.includes('```')) return s;
  // Prefer the fenced block that contains a JSON-looking payload.
  const blocks = [];
  const re = /```[a-zA-Z0-9_-]*[ \t]*\r?\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(s)) !== null) blocks.push(m[1]);
  const jsonish = blocks.filter((b) => /[{\[]/.test(b));
  if (jsonish.length) {
    // longest candidate is almost always the real payload
    return jsonish.sort((a, b) => b.length - a.length)[0].trim();
  }
  // unterminated fence (truncated answer): drop only the opening fence line
  return s.replace(FENCE_RE, '').trim();
}

/** Return the first top-level {...} or [...] slice with balanced brackets (string-aware), or the tail if unbalanced. */
export function extractJsonObject(text) {
  const s = stripFences(normalizeRaw(text));
  const startObj = s.indexOf('{');
  const startArr = s.indexOf('[');
  let start = -1;
  if (startObj >= 0 && startArr >= 0) start = Math.min(startObj, startArr);
  else start = Math.max(startObj, startArr);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return s.slice(start); // unbalanced → caller may try truncation salvage
}

/**
 * Tokenizing repair. Walks the text once, tracking whether we are inside a string,
 * and only edits characters OUTSIDE of strings (comments, trailing commas, single-quoted
 * strings, unquoted keys, Python/JS literals) plus raw control characters INSIDE strings.
 */
export function repairJsonText(raw) {
  const src = extractJsonObject(raw) ?? normalizeRaw(raw);
  const out = [];
  const fixes = new Set();
  let i = 0;
  const n = src.length;
  const isIdStart = (c) => /[A-Za-z_$]/.test(c);
  const isId = (c) => /[A-Za-z0-9_$]/.test(c);

  const readString = (quote) => {
    // returns the string body converted to a valid JSON string (without surrounding quotes)
    let body = '';
    i++; // skip opening quote
    while (i < n) {
      const c = src[i];
      if (c === '\\') {
        const nx = src[i + 1];
        if (nx === undefined) { i++; break; }
        if ('"\\/bfnrtu'.includes(nx)) {
          if (nx === 'u' && !/^[0-9a-fA-F]{4}$/.test(src.slice(i + 2, i + 6))) { body += '\\\\u'; fixes.add('bad-unicode-escape'); i += 2; continue; }
          body += c + nx; i += 2; continue;
        }
        if (nx === "'") { body += "'"; fixes.add('escaped-single-quote'); i += 2; continue; }
        if (nx === '\n') { body += '\\n'; fixes.add('line-continuation'); i += 2; continue; }
        body += '\\\\'; fixes.add('invalid-escape'); i += 1; continue;
      }
      if (c === quote) {
        // For double-quoted strings: decide if this quote really terminates the string.
        if (quote === '"') {
          let j = i + 1;
          while (j < n && /[ \t\r\n]/.test(src[j])) j++;
          const nx = src[j];
          if (nx === undefined || nx === ',' || nx === '}' || nx === ']' || nx === ':') { i++; return body; }
          // string followed by "+" concatenation: "a" + "b"
          if (nx === '+') {
            let k = j + 1;
            while (k < n && /[ \t\r\n]/.test(src[k])) k++;
            if (src[k] === '"' || src[k] === "'") { fixes.add('string-concat'); i = k; return body + readString(src[k]); }
          }
          // next significant char is not structural → this is an unescaped inner quote
          body += '\\"'; fixes.add('unescaped-inner-quote'); i++; continue;
        }
        i++; return body;
      }
      if (c === '\n') { body += '\\n'; fixes.add('raw-newline-in-string'); i++; continue; }
      if (c === '\r') { fixes.add('raw-cr-in-string'); i++; continue; }
      if (c === '\t') { body += '\\t'; fixes.add('raw-tab-in-string'); i++; continue; }
      if (quote === "'" && c === '"') { body += '\\"'; i++; continue; }
      body += c; i++;
    }
    return body; // unterminated (truncated) — caller's salvage step closes it
  };

  const readSmartString = () => {
    i++;
    let body = '';
    while (i < n && src[i] !== '\u201D' && src[i] !== '\u201C' && src[i] !== '"') {
      const c = src[i];
      if (c === '\n') body += '\\n'; else if (c === '\\') body += '\\\\'; else body += c;
      i++;
    }
    i++;
    return body;
  };

  const readTemplate = () => {
    // JS template literal used as a string value → convert to JSON string
    i++;
    let body = '';
    while (i < n && src[i] !== '`') {
      const c = src[i];
      if (c === '\\' && i + 1 < n) { const nx = src[i + 1]; body += nx === '`' ? '`' : '\\' + nx; i += 2; continue; }
      if (c === '"') body += '\\"';
      else if (c === '\n') body += '\\n';
      else if (c === '\r') { /* drop */ } else if (c === '\t') body += '\\t';
      else body += c;
      i++;
    }
    i++;
    fixes.add('template-literal');
    return body;
  };

  while (i < n) {
    const c = src[i];
    if (c === '"') { out.push('"' + readString('"') + '"'); continue; }
    if (c === '\u201C' || c === '\u201D') { out.push('"' + readSmartString() + '"'); fixes.add('smart-quotes'); continue; }
    if (c === "'") { out.push('"' + readString("'") + '"'); fixes.add('single-quotes'); continue; }
    if (c === '`') { out.push('"' + readTemplate() + '"'); continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; fixes.add('line-comment'); continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; fixes.add('block-comment'); continue; }
    if (c === ',') {
      let j = i + 1;
      while (j < n && /[ \t\r\n]/.test(src[j])) j++;
      if (src[j] === '}' || src[j] === ']') { fixes.add('trailing-comma'); i++; continue; }
      if (src[j] === ',') { fixes.add('duplicate-comma'); i++; continue; }
      out.push(','); i++; continue;
    }
    if (isIdStart(c)) {
      let j = i;
      while (j < n && isId(src[j])) j++;
      const word = src.slice(i, j);
      let k = j;
      while (k < n && /[ \t\r\n]/.test(src[k])) k++;
      if (src[k] === ':') { out.push('"' + word + '"'); fixes.add('unquoted-key'); i = j; continue; }
      const lit = { True: 'true', False: 'false', None: 'null', undefined: 'null', NaN: 'null', Infinity: 'null' }[word];
      if (lit) { out.push(lit); fixes.add('python-js-literal'); i = j; continue; }
      out.push(word); i = j; continue;
    }
    out.push(c); i++;
  }

  // missing comma between adjacent values: } { , ] [ , "x" "y"
  let text = out.join('');
  const before = text;
  text = insertMissingCommas(text);
  if (text !== before) fixes.add('missing-comma');
  repairJsonText.lastFixes = [...fixes];
  return text;
}

/** String-aware insertion of commas between `}{`, `]["`, `"x" "y"` style juxtapositions. */
function insertMissingCommas(text) {
  let res = '';
  let inStr = false;
  let esc = false;
  let prevSig = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      res += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') { inStr = false; prevSig = '"'; }
      continue;
    }
    if (/\s/.test(c)) { res += c; continue; }
    if (c === '"') {
      if (prevSig === '}' || prevSig === ']' || prevSig === '"' || /[0-9el]/.test(prevSig)) {
        // value directly followed by a new string without ',' or ':' → missing comma
        res = res.replace(/\s*$/, '') + ',';
      }
      inStr = true; res += c; continue;
    }
    if ((c === '{' || c === '[') && (prevSig === '}' || prevSig === ']')) res = res.replace(/\s*$/, '') + ',';
    res += c;
    prevSig = c;
  }
  return res;
}

/**
 * Close a truncated JSON document at the last point where every container can be closed validly.
 * Everything after that point (a half-written string, a dangling key, a partial number) is dropped —
 * complete elements (e.g. complete files) are always kept. Returns { text, closed, droppedChars }.
 */
export function closeTruncatedJson(text) {
  const s = String(text);
  const stack = []; // { t: 'o'|'a', key: boolean }
  let inStr = false;
  let esc = false;
  let strIsKey = false;
  let safe = -1;
  let safeStack = null;
  const mark = (idx) => { safe = idx; safeStack = stack.map((x) => x.t); };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') { inStr = false; if (!strIsKey && (stack.length === 1 || stack[stack.length - 1]?.t === 'a')) mark(i + 1); }
      continue;
    }
    const top = stack[stack.length - 1];
    if (c === '"') { inStr = true; strIsKey = !!(top && top.t === 'o' && top.key); continue; }
    if (c === '{') { stack.push({ t: 'o', key: true }); continue; }
    if (c === '[') { stack.push({ t: 'a', key: false }); continue; }
    if (c === ':') { if (top) top.key = false; continue; }
    if (c === ',') { if (stack.length === 1 || top?.t === 'a') mark(i); if (top && top.t === 'o') top.key = true; continue; }
    if (c === '}' || c === ']') { stack.pop(); mark(i + 1); continue; }
  }
  if (!stack.length && !inStr) return { text: s, closed: false, droppedChars: 0 };
  // Nothing complete was produced before the cut → there is nothing to salvage (never fabricate `{}`).
  if (safe < 0) return { text: s, closed: false, droppedChars: s.length };
  const closers = safeStack.slice().reverse().map((t) => (t === 'o' ? '}' : ']')).join('');
  return { text: s.slice(0, safe).replace(/,\s*$/, '') + closers, closed: true, droppedChars: s.length - safe };
}

const PATH_KEYS = ['path', 'file', 'filename', 'filepath', 'name'];
const CONTENT_KEYS = ['content', 'code', 'text', 'source', 'body', 'contents'];

/** Map alternative shapes to { files: [{path, content}], ...rest }. Never creates content. */
export function normalizeShape(value) {
  if (value == null) return value;
  let v = value;
  // unwrap single-key containers
  for (let depth = 0; depth < 3 && v && typeof v === 'object' && !Array.isArray(v); depth++) {
    const keys = Object.keys(v);
    if (keys.length === 1 && ['app', 'result', 'data', 'response', 'output'].includes(keys[0]) && typeof v[keys[0]] === 'object') v = v[keys[0]];
    else break;
  }
  if (Array.isArray(v) && v.length && typeof v[0] === 'object' && (PATH_KEYS.some((k) => k in v[0]))) v = { files: v };
  if (v && typeof v === 'object' && !Array.isArray(v) && v.files != null) {
    let files = v.files;
    if (files && !Array.isArray(files) && typeof files === 'object') {
      files = Object.entries(files).map(([p, c]) => ({ path: p, content: typeof c === 'string' ? c : (c?.content ?? c?.code ?? '') }));
    }
    if (Array.isArray(files)) {
      files = files.map((f) => {
        if (!f || typeof f !== 'object') return f;
        const pk = PATH_KEYS.find((k) => typeof f[k] === 'string');
        const ck = CONTENT_KEYS.find((k) => f[k] != null);
        if (!pk && !ck) return f;
        const content = Array.isArray(f[ck]) ? f[ck].join('\n') : f[ck];
        return { ...f, path: f.path ?? f[pk], content: typeof content === 'string' ? content : f.content };
      });
      v = { ...v, files };
    }
  }
  return v;
}

/**
 * Parse an AI answer into a JSON value.
 * Returns { ok, value, trace[], repaired[], partial?, salvaged? , error? }.
 */
export function parseJsonLenient(text) {
  const trace = [];
  const norm = normalizeRaw(text);
  const unfenced = stripFences(norm);
  try {
    return { ok: true, value: JSON.parse(unfenced), trace: ['direct'], repaired: [] };
  } catch { trace.push('direct-fail'); }
  const candidate = extractJsonObject(unfenced);
  if (candidate) {
    try {
      return { ok: true, value: JSON.parse(candidate), trace: [...trace, 'extracted'], repaired: [] };
    } catch { trace.push('extract-fail'); }
  }
  let repaired = '';
  try {
    repaired = repairJsonText(unfenced);
    const fixes = repairJsonText.lastFixes || [];
    try {
      return { ok: true, value: JSON.parse(repaired), trace: [...trace, 'repaired'], repaired: fixes };
    } catch { trace.push('repair-fail'); }
    const closed = closeTruncatedJson(repaired);
    if (closed.closed) {
      try {
        const value = JSON.parse(closed.text);
        return { ok: true, value, trace: [...trace, 'truncation-salvage'], repaired: fixes, partial: true, salvaged: describeSalvage(value) };
      } catch { trace.push('salvage-fail'); }
    }
  } catch { trace.push('repair-crash'); }
  const files = salvageFileBlocks(norm);
  if (files.length) {
    return { ok: true, value: { files }, trace: [...trace, 'file-blocks'], repaired: [], partial: true, salvaged: { files: files.length } };
  }
  return { ok: false, value: null, trace, repaired: [], error: 'AI_FORMAT' };
}

function describeSalvage(value) {
  const files = Array.isArray(value?.files) ? value.files : [];
  return { files: files.length, lastPath: files.length ? files[files.length - 1]?.path || null : null };
}

/** Delimiter protocol: <<<FILE path="x">>> ... <<<END FILE>>> — truncation loses at most the last block. */
export function salvageFileBlocks(text) {
  const out = [];
  const s = String(text ?? '');
  const re = /<<<FILE\s+path\s*=\s*"([^"]+)"\s*>>>\r?\n?([\s\S]*?)<<<END FILE>>>/g;
  let m;
  while ((m = re.exec(s)) !== null) out.push({ path: m[1], content: m[2].replace(/\r?\n$/, '') });
  return out;
}

/** Detect whether the last file block was cut off (opened but never closed). */
export function hasUnclosedFileBlock(text) {
  const s = String(text ?? '');
  const opens = (s.match(/<<<FILE\s+path\s*=/g) || []).length;
  const closes = (s.match(/<<<END FILE>>>/g) || []).length;
  return opens > closes;
}

/** NEED_FILES protocol, in either text form `[NEED_FILES: a.js, b.js:10-40]` or JSON form {"need_files":[...]}. */
export function parseNeedFiles(text) {
  const s = String(text || '');
  const out = [];
  const pushAll = (arr) => {
    for (const x of arr || []) {
      const t = String(x || '').trim();
      if (t && !out.includes(t)) out.push(t);
    }
  };
  const m = s.match(/\[NEED_FILES:\s*([^\]]+)\]/i);
  if (m) pushAll(m[1].split(/[,\n]/).map((x) => x.trim()).filter(Boolean));
  // bare JSON object or fenced
  if (s.includes('{')) {
    const parsed = parseJsonLenient(s);
    const j = parsed.ok ? parsed.value : null;
    if (j) {
      pushAll(j.need_files || j.needFiles);
      // allow { "files_needed": ["a.js"] }
      pushAll(j.files_needed || j.filesNeeded);
    }
  }
  return out;
}

export default { normalizeRaw, parseJsonLenient, salvageFileBlocks, parseNeedFiles, repairJsonText, closeTruncatedJson, normalizeShape, hasUnclosedFileBlock, extractJsonObject };
