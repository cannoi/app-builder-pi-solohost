import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, listFiles } from '../utils/fsx.js';
import { safeSlug } from '../utils/ids.js';
import { importZipBuffer } from './importer.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

const TEXT_EXT = new Set(['.txt','.md','.json','.js','.mjs','.cjs','.ts','.tsx','.jsx','.html','.css','.yml','.yaml','.xml','.csv','.env','.sql','.py','.go','.rs','.java','.php','.sh','.bat','.ps1','.toml']);
const IMAGE_EXT = new Set(['.jpg','.jpeg','.png','.gif','.webp']);

export async function saveAttachment(projectRoot, file) {
  const root = path.join(projectRoot, 'attachments');
  await ensureDir(root);
  const original = file.originalname || 'file';
  const ext = path.extname(original).toLowerCase();
  const safeBase = safeSlug(path.basename(original, ext)).slice(0, 50) || 'file';
  const safeName = `${Date.now()}-${safeBase}${ext}`;
  const full = path.join(root, safeName);
  await fs.writeFile(full, file.buffer);
  const meta = { name: original, stored: safeName, type: file.mimetype || 'application/octet-stream', bytes: file.buffer.length, kind: IMAGE_EXT.has(ext) ? 'image' : ext === '.zip' ? 'zip' : TEXT_EXT.has(ext) ? 'text' : 'binary' };
  return { ...meta, path: full, dataUrl: IMAGE_EXT.has(ext) ? `data:${meta.type};base64,${file.buffer.toString('base64')}` : null };
}

export async function attachmentContext(projectRoot) {
  const root = path.join(projectRoot, 'attachments');
  const files = await listFiles(root).catch(() => []);
  const parts = [];
  for (const rel of files.slice(0, 80)) {
    const full = path.join(root, rel);
    const ext = path.extname(rel).toLowerCase();
    if (TEXT_EXT.has(ext)) {
      const text = await fs.readFile(full, 'utf8').catch(() => '');
      parts.push(`FILE ${rel}\n${text.slice(0, 12000)}`);
    } else if (ext === '.pdf') {
      let text = '';
      try { const r = await exec('pdftotext', ['-layout', full, '-'], { timeout: 20000, maxBuffer: 2 * 1024 * 1024 }); text = r.stdout || ''; } catch {}
      parts.push(`FILE ${rel}\n${text.slice(0, 12000) || '[PDF text extraction unavailable; inspect the attached file metadata.]'}`);
    } else if (ext === '.docx' || ext === '.xlsx') {
      let text = '';
      try { const r = await exec('unzip', ['-p', full, ext === '.docx' ? 'word/document.xml' : 'xl/sharedStrings.xml'], { timeout: 20000, maxBuffer: 2 * 1024 * 1024 }); text = String(r.stdout || '').replace(/<[^>]+>/g, ' '); } catch {}
      parts.push(`FILE ${rel}\n${text.slice(0, 12000) || '[Office document text extraction unavailable.]'}`);
    } else if (ext === '.zip') {
      let listing = '';
      try { const r = await exec('unzip', ['-l', full], { timeout: 20000, maxBuffer: 2 * 1024 * 1024 }); listing = r.stdout || ''; } catch {}
      parts.push(`FILE ${rel}\nZIP CONTENTS\n${listing.slice(-12000)}`);
    } else {
      const stat = await fs.stat(full).catch(() => null);
      parts.push(`FILE ${rel} (${stat ? stat.size : 0} bytes, ${ext || 'binary'})`);
    }
  }
  return parts.join('\n\n').slice(0, 50000);
}

export async function attachmentList(projectRoot) {
  const root = path.join(projectRoot, 'attachments');
  const files = await listFiles(root).catch(() => []);
  return Promise.all(files.map(async (rel) => {
    const full = path.join(root, rel);
    const stat = await fs.stat(full).catch(() => ({ size: 0 }));
    return { path: rel, bytes: stat.size, type: path.extname(rel).toLowerCase() };
  }));
}

export async function importAttachmentZip(projectSourceDir, file) {
  return importZipBuffer(file.buffer, projectSourceDir);
}

export async function imageInputsFromAttachments(projectRoot, maxImages = 3) {
  const root = path.join(projectRoot, 'attachments');
  const files = await listFiles(root).catch(() => []);
  const out = [];
  for (const rel of files) {
    const ext = path.extname(rel).toLowerCase();
    if (!IMAGE_EXT.has(ext)) continue;
    const full = path.join(root, rel);
    const buf = await fs.readFile(full).catch(() => null);
    if (!buf || buf.length > 32 * 1024 * 1024) continue;
    const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : `image/${ext.slice(1)}`;
    out.push({ dataUrl: `data:${mime};base64,${buf.toString('base64')}` });
    if (out.length >= maxImages) break;
  }
  return out;
}
