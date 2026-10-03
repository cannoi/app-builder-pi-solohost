export function extractJson(text) {
  if (!text) return null;
  if (typeof text === 'object' && text !== null) return text;
  const raw = String(text).trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  try { return JSON.parse(candidate); } catch { /* continue */ }

  // Model-agnostic balanced-object extraction. This handles prose before/after
  // JSON and braces embedded in quoted strings without relying on a provider.
  const object = balancedJsonCandidate(candidate, '{', '}');
  if (object) { try { return JSON.parse(object); } catch { /* continue */ } }
  const array = balancedJsonCandidate(candidate, '[', ']');
  if (array) { try { return JSON.parse(array); } catch { /* continue */ } }
  return null;
}

function balancedJsonCandidate(text, open, close) {
  const start = text.indexOf(open);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Normalize any AI provider response into a plain object/array when possible.
 * Does not invent code or patches — only extracts and shapes existing content.
 * Returns { ok, value, code, warning }.
 */
export function normalizeAIResponse(input, { aliases = true } = {}) {
  if (input == null) {
    return { ok: false, value: null, code: 'AI_RESPONSE_MALFORMED', warning: 'empty response' };
  }
  if (typeof input === 'object' && !Buffer.isBuffer(input)) {
    const shaped = aliases ? applyFieldAliases(input) : input;
    return { ok: true, value: shaped, code: null, warning: null };
  }
  const text = String(input);
  const parsed = extractJson(text);
  if (parsed != null) {
    const shaped = aliases && typeof parsed === 'object' && !Array.isArray(parsed)
      ? applyFieldAliases(parsed)
      : parsed;
    return { ok: true, value: shaped, code: null, warning: null };
  }
  return { ok: false, value: null, code: 'AI_RESPONSE_MALFORMED', warning: 'could not extract JSON' };
}

const FIELD_ALIASES = {
  files: ['files', 'changedFiles', 'changed_files', 'patches', 'edits', 'changes'],
  root_cause: ['root_cause', 'rootCause', 'cause', 'problem'],
  explanation: ['explanation', 'reason', 'summary', 'message'],
  verification: ['verification', 'checks', 'verify', 'validation'],
  expected_result: ['expected_result', 'expectedResult', 'expected'],
  recommendation: ['recommendation', 'recommend', 'advice'],
  risk: ['risk', 'riskLevel', 'risk_level'],
  steps: ['steps', 'plan_steps', 'actions'],
  evidence: ['evidence', 'proof'],
  warnings: ['warnings', 'warns'],
  errors: ['errors', 'error_list'],
  tests: ['tests', 'test_cases'],
  expected_files: ['expected_files', 'expectedFiles', 'derived_files', 'derivedFiles'],
};

function applyFieldAliases(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const out = { ...obj };
  for (const [canonical, names] of Object.entries(FIELD_ALIASES)) {
    if (out[canonical] != null) continue;
    for (const name of names) {
      if (name !== canonical && out[name] != null) {
        out[canonical] = out[name];
        break;
      }
    }
  }
  for (const key of ['files', 'verification', 'steps', 'evidence', 'warnings', 'errors', 'tests', 'expected_files', 'changedFiles', 'actions', 'patches']) {
    if (out[key] != null) out[key] = normalizeArray(out[key]);
  }
  return out;
}

/**
 * Safe array normalization for AI/optional fields.
 * Never throws; invalid values become [].
 */
export function normalizeArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  if (typeof value === 'string') {
    const t = value.trim();
    if (!t) return [];
    if (t.startsWith('[') || t.startsWith('{')) {
      try {
        const parsed = JSON.parse(t);
        if (Array.isArray(parsed)) return parsed;
        if (parsed != null && typeof parsed === 'object') return [parsed];
      } catch { /* fall through */ }
    }
    return [t];
  }
  if (typeof value === 'object') return [value];
  return [];
}

export function requireFields(obj, fields) {
  if (!obj || typeof obj !== 'object') return false;
  return fields.every((f) => Object.prototype.hasOwnProperty.call(obj, f));
}

export function clampText(s, max = 12000) {
  const t = String(s || '');
  return t.length > max ? t.slice(0, max) + '\n/* truncated */' : t;
}
