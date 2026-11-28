/** Normalize validator / API errors to plain strings (avoid "[object Object]"). */
export function formatSoloHostErrors(errors) {
  if (errors == null) return 'Unknown SoloHost validation error';
  if (typeof errors === 'string') return errors;
  if (!Array.isArray(errors)) {
    if (typeof errors === 'object') {
      return String(errors.message || errors.detail || errors.error || JSON.stringify(errors)).slice(0, 800);
    }
    return String(errors);
  }
  return errors
    .map((e) => {
      if (typeof e === 'string') return e;
      if (e && typeof e === 'object') return String(e.message || e.detail || e.error || e.code || e.rule || JSON.stringify(e));
      return String(e);
    })
    .filter(Boolean)
    .join('; ')
    .slice(0, 1200);
}
