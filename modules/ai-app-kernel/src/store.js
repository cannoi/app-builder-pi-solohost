import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export function createMemoryStore(seed = {}) {
  const data = structuredClone(seed);
  return adapterFromMaps(data);
}

export function createJsonFileStore(filePath, seed = {}) {
  let cache = null;
  async function load() {
    if (cache) return cache;
    let raw;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      cache = structuredClone(seed);
      await save();
      return cache;
    }
    try { cache = JSON.parse(raw); }
    catch (err) { throw new Error(`Store JSON is invalid; refusing to overwrite "${filePath}": ${err.message}`); }
    if (!cache || typeof cache !== 'object' || Array.isArray(cache)) {
      throw new Error(`Store JSON must contain an object; refusing to overwrite "${filePath}".`);
    }
    return cache;
  }
  async function save() {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(tempPath, JSON.stringify(cache, null, 2), { mode: 0o600 });
      await fs.rename(tempPath, filePath);
    } finally {
      await fs.rm(tempPath, { force: true }).catch(() => {});
    }
  }
  const inner = () => adapterFromMaps(cache);
  return {
    kind: 'json-file',
    async listCollections() { return Object.keys(await load()); },
    async list(col, filter) { await load(); return inner().list(col, filter); },
    async get(col, id) { await load(); return inner().get(col, id); },
    async put(col, record) { await load(); const out = await inner().put(col, record); await save(); return out; },
    async delete(col, id) { await load(); const out = await inner().delete(col, id); await save(); return out; },
  };
}

export function createCustomStore(handlers) {
  return {
    kind: 'custom',
    listCollections: handlers.listCollections,
    list: handlers.list,
    get: handlers.get,
    put: handlers.put,
    delete: handlers.delete,
  };
}

function adapterFromMaps(data) {
  function col(name) {
    if (!data[name]) data[name] = [];
    if (!Array.isArray(data[name])) data[name] = Object.values(data[name]);
    return data[name];
  }
  return {
    kind: 'memory',
    async listCollections() { return Object.keys(data); },
    async list(name, filter = {}) {
      return col(name).filter((row) => Object.entries(filter).every(([k, v]) => String(row?.[k]) === String(v)));
    },
    async get(name, id) { return col(name).find((row) => String(row.id) === String(id)) || null; },
    async put(name, record) {
      const rows = col(name);
      const item = { ...record, id: record.id || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}` };
      const i = rows.findIndex((row) => String(row.id) === String(item.id));
      if (i >= 0) rows[i] = { ...rows[i], ...item };
      else rows.push(item);
      return item;
    },
    async delete(name, id) {
      const rows = col(name);
      const i = rows.findIndex((row) => String(row.id) === String(id));
      if (i < 0) return { deleted: false };
      rows.splice(i, 1);
      return { deleted: true, id };
    },
  };
}
