import { isProtectedFilePath } from '../security/policy.js';

const SECRET_RE = /(api[_-]?key|token|secret|password|authorization|bearer)\s*[=:]\s*['"]?([^\s'"]+)/gi;
const KEYISH_RE = /\b(AIza[0-9A-Za-z\-_]{20,}|sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;
const NAMED_SECRET_RE = /(["']?[\w.-]*(?:api[_-]?key|access[_-]?token|token|secret|password|passwd|authorization|private[_-]?key|wallet[_-]?(?:seed|key|passphrase))[\w.-]*["']?\s*[:=]\s*)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s,;}]+)/gi;
const PRIVATE_KEY_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi;

export function maskKey(value) {
  if (!value) return '';
  const s = String(value);
  if (s.length <= 8) return '****';
  return `${s.slice(0, 4)}...****${s.slice(-4)}`;
}

export function maskSecrets(text) {
  if (text == null) return text;
  return String(text)
    .replace(PRIVATE_KEY_RE, '[REDACTED PRIVATE KEY]')
    .replace(NAMED_SECRET_RE, '$1[REDACTED]')
    .replace(SECRET_RE, (_, name, val) => `${name}=${maskKey(val)}`)
    .replace(KEYISH_RE, (m) => maskKey(m));
}

export function redactAiContext(text, { filename = '' } = {}) {
  if (filename && isProtectedFilePath(filename)) return `[PROTECTED FILE CONTENT OMITTED: ${String(filename).replace(/[\r\n]/g, '')}]`;
  return maskSecrets(text);
}

export function looksLikeSecret(text) {
  if (!text) return false;
  const s = String(text);
  KEYISH_RE.lastIndex = 0;
  return KEYISH_RE.test(s) || /BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY/.test(s);
}
