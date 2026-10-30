import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { ensureDir, listFiles } from './fsx.js';

const deflateRaw = promisify(zlib.deflateRaw);
const inflateRaw = promisify(zlib.inflateRaw);

export async function writeZip(sourceDir, zipPath, { skip = [] } = {}) {
  const files = await listFiles(sourceDir);
  const entries = [];
  for (const rel of files) {
    if (skip.some((p) => rel === p || rel.startsWith(p))) continue;
    if (rel === '.env' || rel.endsWith('/.env') || rel.includes('/node_modules/') || rel.startsWith('.git/')) continue;
    const data = await fs.readFile(path.join(sourceDir, rel));
    entries.push({ name: rel.replace(/\\/g, '/'), data });
  }
  const buf = await packZip(entries);
  await ensureDir(path.dirname(zipPath));
  await fs.writeFile(zipPath, buf);
  return { path: zipPath, files: entries.map((e) => e.name), bytes: buf.length };
}

export async function readZip(zipBuf, destDir) {
  const entries = unpackZip(Buffer.isBuffer(zipBuf) ? zipBuf : Buffer.from(zipBuf));
  await ensureDir(destDir);
  const written = [];
  for (const e of entries) {
    if (!e.name || e.name.endsWith('/')) continue;
    const safe = e.name.replace(/^\/+/, '').replace(/\\/g, '/');
    if (safe.includes('..')) continue;
    const out = path.join(destDir, safe);
    await ensureDir(path.dirname(out));
    await fs.writeFile(out, e.data);
    written.push(safe);
  }
  return written;
}

export async function packZip(entries) {
  const chunks = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const compressed = await deflateRaw(raw);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const localFull = Buffer.concat([local, name, compressed]);
    chunks.push(localFull);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));
    offset += localFull.length;
  }
  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralDir, end]);
}

export function unpackZip(buf) {
  const entries = [];
  let i = 0;
  while (i + 30 <= buf.length) {
    const sig = buf.readUInt32LE(i);
    if (sig === 0x02014b50 || sig === 0x06054b50) break;
    if (sig !== 0x04034b50) break;
    const method = buf.readUInt16LE(i + 8);
    const crc = buf.readUInt32LE(i + 14);
    const compSize = buf.readUInt32LE(i + 18);
    const rawSize = buf.readUInt32LE(i + 22);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.slice(i + 30, i + 30 + nameLen).toString('utf8');
    const start = i + 30 + nameLen + extraLen;
    const comp = buf.slice(start, start + compSize);
    let data = comp;
    if (method === 8) data = zlib.inflateRawSync(comp);
    else if (method !== 0) throw new Error(`Unsupported ZIP method ${method} in ${name}`);
    entries.push({ name, data, crc, rawSize });
    i = start + compSize;
  }
  return entries;
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
