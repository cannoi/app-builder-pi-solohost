/** Mask secrets in log lines. */
export function maskSecrets(text) {
  let s = String(text ?? '');
  s = s.replace(/cannoi_[A-Za-z0-9]+/g, 'cannoi_***');
  s = s.replace(/ghp_[A-Za-z0-9]+/g, 'ghp_***');
  s = s.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***');
  s = s.replace(/(api[_-]?key|token|password|secret)(["']?\s*[:=]\s*["']?)[^"'\s,;]+/gi, '$1$2***');
  return s;
}
export default { maskSecrets };
