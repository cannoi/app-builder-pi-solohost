import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export class CredentialVault {
  constructor(dataDir) {
    this.dir = dataDir || './data';
    fs.mkdirSync(this.dir, { recursive: true });
    this.keyPath = path.join(this.dir, 'ai-provider-hub.key');
    this.key = this.loadOrCreateKey();
    this.filePath = path.join(this.dir, 'ai-provider-hub.credentials.json');
    this.state = this.load();
  }

  loadOrCreateKey() {
    if (fs.existsSync(this.keyPath)) return Buffer.from(fs.readFileSync(this.keyPath, 'utf8').trim(), 'base64');
    const key = crypto.randomBytes(32);
    fs.writeFileSync(this.keyPath, key.toString('base64'), { mode: 0o600 });
    try { fs.chmodSync(this.keyPath, 0o600); } catch {}
    return key;
  }

  load() {
    try { return JSON.parse(fs.readFileSync(this.filePath, 'utf8')); } catch { return {}; }
  }

  persist() {
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch {}
    fs.renameSync(tmp, this.filePath);
  }

  encrypt(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
    return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${ciphertext.toString('base64')}`;
  }

  decrypt(value) {
    const [ivB64, tagB64, dataB64] = String(value).split('.');
    if (!ivB64 || !tagB64 || !dataB64) return '';
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  }

  set(ref, value) {
    if (!ref || !value) return;
    this.state[String(ref)] = this.encrypt(value);
    this.persist();
  }

  get(ref) {
    const value = this.state[String(ref)];
    if (!value) return '';
    try { return this.decrypt(value); } catch { return ''; }
  }

  remove(ref) {
    delete this.state[String(ref)];
    this.persist();
  }
}
