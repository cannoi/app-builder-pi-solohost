import { maskSecrets } from './mask.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(level = 'info') {
  const min = LEVELS[level] ?? 20;
  function write(lvl, msg, extra) {
    if ((LEVELS[lvl] ?? 20) < min) return;
    const line = {
      ts: new Date().toISOString(),
      level: lvl,
      message: maskSecrets(String(msg)),
    };
    if (extra && typeof extra === 'object') {
      for (const [k, v] of Object.entries(extra)) {
        line[k] = typeof v === 'string' ? maskSecrets(v) : v;
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
