export function extractJson(text) {
  if (!text) return null;
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

export function requireFields(obj, fields) {
  if (!obj || typeof obj !== 'object') return false;
  return fields.every((f) => Object.prototype.hasOwnProperty.call(obj, f));
}

export function clampText(s, max = 12000) {
  const t = String(s || '');
  return t.length > max ? t.slice(0, max) + '\n/* truncated */' : t;
}
