import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

async function ensureMaster(masterFile) {
  try { return (await fs.readFile(masterFile, 'utf8')).trim(); } catch {}
  const key = crypto.randomBytes(32).toString('base64url');
  await fs.mkdir(path.dirname(masterFile), { recursive: true });
  await fs.writeFile(masterFile, key, { mode: 0o600 });
  return key;
}

export function createSecretVault(file, masterFile = './data/.ai-master-key') {
  let cache = null;
  async function load() {
    if (cache) return cache;
    try { cache = JSON.parse(await fs.readFile(file, 'utf8')); } catch { cache = {}; }
    return cache;
  }
  async function save() { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(cache, null, 2), { mode: 0o600 }); }
  async function keyMaterial() {
    const env = process.env.AI_HUB_MASTER_KEY;
    const raw = env || await ensureMaster(masterFile);
    return crypto.createHash('sha256').update(raw).digest();
  }
  return {
    async set(id, secret) {
      cache = await load();
      const key = await keyMaterial();
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
      cache[id] = { v: 1, iv: iv.toString('base64'), data: encrypted.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
      await save();
    },
    async get(id) {
      cache = await load(); const item = cache[id]; if (!item) return null;
      const key = await keyMaterial(); const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(item.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(item.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(item.data, 'base64')), decipher.final()]).toString('utf8');
    },
    async remove(id) { cache = await load(); delete cache[id]; await save(); },
    async ids() { cache = await load(); return Object.keys(cache); }
  };
}
