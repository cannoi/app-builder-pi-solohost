const SECRET_RE = /(api[_-]?key|token|secret|password|authorization|bearer)\s*[=:]\s*['"]?([^\s'"]+)/gi;
const KEYISH_RE = /\b(AIza[0-9A-Za-z\-_]{20,}|sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;

export function maskKey(value) {
  if (!value) return '';
  const s = String(value);
  if (s.length <= 8) return '****';
  return `${s.slice(0, 4)}...****${s.slice(-4)}`;
}

export function maskSecrets(text) {
  if (text == null) return text;
  return String(text)
    .replace(SECRET_RE, (_, name, val) => `${name}=${maskKey(val)}`)
    .replace(KEYISH_RE, (m) => maskKey(m));
}

export function looksLikeSecret(text) {
  if (!text) return false;
  const s = String(text);
  KEYISH_RE.lastIndex = 0;
  return KEYISH_RE.test(s) || /BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY/.test(s);
}
