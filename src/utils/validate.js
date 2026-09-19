export function extractJson(text) {
  if (!text) return null;
  const raw = String(text).trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(candidate.slice(start, end + 1)); } catch { /* continue */ }
  }
  const aStart = candidate.indexOf('[');
  const aEnd = candidate.lastIndexOf(']');
  if (aStart >= 0 && aEnd > aStart) {
    try { return JSON.parse(candidate.slice(aStart, aEnd + 1)); } catch { /* continue */ }
  }
  try { return JSON.parse(candidate); } catch { return null; }
}

export function requireFields(obj, fields) {
  if (!obj || typeof obj !== 'object') return false;
  return fields.every((f) => Object.prototype.hasOwnProperty.call(obj, f));
}

export function clampText(s, max = 12000) {
  const t = String(s || '');
  return t.length > max ? t.slice(0, max) + '\n/* truncated */' : t;
}
