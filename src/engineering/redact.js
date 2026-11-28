/**
 * Engineering Toolkit redactor (D-02 / rule 0.4).
 * Masks provider keys, GitHub tokens, private keys, KEY=value secrets and the
 * configured Feedback Hub token / hub id before text reaches logs, audit files,
 * AI prompts, executor output, screenshots metadata or reports.
 * Reads the Feedback values through loadConfig() — it never changes them.
 */
import { maskSecrets } from '../utils/mask.js';
import { loadConfig } from '../config/loader.js';

const PROVIDER_RE = /\b(AIza[0-9A-Za-z\-_]{20,}|sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|npm_[A-Za-z0-9]{20,})\b/g;
const PRIVATE_KEY_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g;
const URL_CRED_RE = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:@/]+):([^\s@/]+)@/gi;
const ENV_ASSIGN_RE = /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE|PAT|CREDENTIALS?|DATABASE_URL))\s*[=:]\s*['"]?([^\s'"]+)/g;

const extraValues = new Set();

/** Register additional literal secret values (e.g. a key typed in Settings) for masking. */
export function registerSecretValues(values = []) {
  for (const v of values) {
    const s = String(v || '');
    if (s.length >= 6) extraValues.add(s);
  }
  resetSecretCache();
}

let cache = null;
let cacheAt = 0;
const CACHE_MS = 10_000;
/** Test hook / Settings change: forget the cached configured values. */
export function resetSecretCache() { cache = null; cacheAt = 0; }

export function configuredSecretValues() {
  if (cache && Date.now() - cacheAt < CACHE_MS) return cache;
  cache = computeSecretValues();
  cacheAt = Date.now();
  return cache;
}

function computeSecretValues() {
  const out = new Set(extraValues);
  try {
    const cfg = loadConfig();
    const fb = cfg.feedbackHub || {};
    for (const v of [fb.ingestToken, fb.hubId, cfg.ai?.geminiKey, cfg.ai?.deepseekKey, cfg.github?.token, cfg.accessPassword]) {
      if (v && String(v).length >= 6) out.add(String(v));
    }
  } catch { /* config unavailable: pattern masking still applies */ }
  for (const k of ['SHFH_INGEST_TOKEN', 'SHFH_HUB_ID', 'GITHUB_TOKEN', 'GH_TOKEN', 'GEMINI_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'NPM_TOKEN', 'BUILDER_ACCESS_PASSWORD', 'ACCESS_PASSWORD']) {
    const v = process.env[k];
    if (v && v.length >= 6) out.add(v);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

export function redactText(text) {
  if (text == null) return text;
  let s = String(text);
  for (const v of configuredSecretValues()) {
    if (s.includes(v)) s = s.split(v).join('[REDACTED]');
  }
  s = s.replace(PRIVATE_KEY_RE, '[REDACTED PRIVATE KEY]');
  s = s.replace(URL_CRED_RE, (_m, scheme, user) => `${scheme}${user}:[REDACTED]@`);
  s = s.replace(ENV_ASSIGN_RE, (_m, name) => `${name}=[REDACTED]`);
  s = s.replace(PROVIDER_RE, '[REDACTED]');
  return maskSecrets(s);
}

/** Deep-redact strings inside plain JSON-like values. */
export function redactDeep(value, depth = 0) {
  if (depth > 8 || value == null) return value;
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/(token|secret|password|passphrase|api[_-]?key|authorization)/i.test(k) && typeof v === 'string' && v) out[k] = '[REDACTED]';
      else out[k] = redactDeep(v, depth + 1);
    }
    return out;
  }
  return value;
}
