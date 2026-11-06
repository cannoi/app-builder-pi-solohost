import { promises as fs } from 'node:fs';
import path from 'node:path';

export function createActivityLogger(file, maxEntries = 2000) {
  let entries = null;
  async function load() {
    if (entries) return entries;
    try { entries = JSON.parse(await fs.readFile(file, 'utf8')); if (!Array.isArray(entries)) entries = []; }
    catch { entries = []; }
    return entries;
  }
  async function save() {
    await fs.mkdir(path.dirname(path.resolve(file)), { recursive: true });
    await fs.writeFile(file, JSON.stringify(entries.slice(-maxEntries), null, 2), { mode: 0o600 });
  }
  const redact = value => JSON.parse(JSON.stringify(value, (k, v) => /^(token|apiKey|api_key|rawKey|raw_key|authorization|secret|password|credential)$/i.test(k) ? '[REDACTED]' : v));
  return {
    async write(event, level = 'info', details = {}) { entries = await load(); entries.push({ id: cryptoId(), ts: new Date().toISOString(), level, event, details: redact(details) }); await save(); },
    async list({ limit = 200 } = {}) { entries = await load(); return entries.slice(-Math.max(1, Math.min(limit, maxEntries))).reverse(); },
    async clear() { entries = []; await save(); }
  };
}
function cryptoId() { return Math.random().toString(36).slice(2, 10); }
