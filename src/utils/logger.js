import { maskSecrets } from './mask.js';
import { redactText } from '../engineering/redact.js';

// v1.10.0 (rule 0.4): configured values (Feedback Hub token / hub id, provider keys, GitHub token, access
// password) are masked in every log line, in addition to pattern masking. Values are read, never changed.
const clean = (v) => redactText(maskSecrets(String(v)));
const cleanDeep = (v, depth = 0) => {
  if (typeof v === 'string') return clean(v);
  if (depth > 4 || v == null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => cleanDeep(x, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = cleanDeep(x, depth + 1);
  return out;
};

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(level = 'info') {
  const min = LEVELS[level] ?? 20;
  function write(lvl, msg, extra) {
    if ((LEVELS[lvl] ?? 20) < min) return;
    const line = {
      ts: new Date().toISOString(),
      level: lvl,
      message: clean(msg),
    };
    if (extra && typeof extra === 'object') {
      for (const [k, v] of Object.entries(extra)) {
        line[k] = cleanDeep(v);
      }
    }
    const out = lvl === 'error' ? console.error : console.log;
    out(JSON.stringify(line));
  }
  return {
    debug: (m, e) => write('debug', m, e),
    info: (m, e) => write('info', m, e),
    warn: (m, e) => write('warn', m, e),
    error: (m, e) => write('error', m, e),
  };
}
