import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { listFiles } from '../utils/fsx.js';

const SKIP = /(^|\/)(node_modules|\.git|\.output|dist|build|coverage|\.cache)(\/|$)/i;

export async function snapshotTree(sourceDir) {
  const files = (await listFiles(sourceDir).catch(() => []))
    .map((f) => String(f).replace(/\\/g, '/'))
    .filter((f) => f && !SKIP.test(f));
  const entries = {};
  for (const rel of files) {
    try {
      const buf = await fs.readFile(path.join(sourceDir, rel));
      entries[rel] = {
        size: buf.length,
        sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      };
    } catch { /* skip unreadable */ }
  }
  return { capturedAt: new Date().toISOString(), fileCount: Object.keys(entries).length, entries };
}

export function diffTrees(before, after) {
  const a = before?.entries || {};
  const b = after?.entries || {};
  const added = [];
  const removed = [];
  const modified = [];
  const unchanged = [];
  const all = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const rel of [...all].sort()) {
    if (!a[rel] && b[rel]) added.push({ path: rel, size: b[rel].size });
    else if (a[rel] && !b[rel]) removed.push({ path: rel, size: a[rel].size });
    else if (a[rel].sha256 !== b[rel].sha256) {
      modified.push({ path: rel, beforeSize: a[rel].size, afterSize: b[rel].size });
    } else unchanged.push(rel);
  }
  return {
    added,
    removed,
    modified,
    unchangedCount: unchanged.length,
    summary: {
      added: added.length,
      removed: removed.length,
      modified: modified.length,
      unchanged: unchanged.length,
    },
  };
}

export function formatDiffBrief(diff, { locale = 'en' } = {}) {
  const s = diff.summary || {};
  if (locale === 'vi') {
    const lines = [
      `So sánh với bản trước khi import:`,
      `• Thêm: ${s.added || 0} file`,
      `• Mất: ${s.removed || 0} file`,
      `• Sửa: ${s.modified || 0} file`,
      `• Giữ nguyên: ${s.unchanged || 0} file`,
    ];
    if (diff.added?.length) lines.push(`Thêm (ví dụ): ${diff.added.slice(0, 8).map((x) => x.path).join(', ')}`);
    if (diff.removed?.length) lines.push(`Mất (ví dụ): ${diff.removed.slice(0, 8).map((x) => x.path).join(', ')}`);
    if (diff.modified?.length) lines.push(`Sửa (ví dụ): ${diff.modified.slice(0, 8).map((x) => x.path).join(', ')}`);
    return lines.join('\n');
  }
  const lines = [
    `Compared to the version before this import:`,
    `• Added: ${s.added || 0} file(s)`,
    `• Removed: ${s.removed || 0} file(s)`,
    `• Modified: ${s.modified || 0} file(s)`,
    `• Unchanged: ${s.unchanged || 0} file(s)`,
  ];
  if (diff.added?.length) lines.push(`Added (sample): ${diff.added.slice(0, 8).map((x) => x.path).join(', ')}`);
  if (diff.removed?.length) lines.push(`Removed (sample): ${diff.removed.slice(0, 8).map((x) => x.path).join(', ')}`);
  if (diff.modified?.length) lines.push(`Modified (sample): ${diff.modified.slice(0, 8).map((x) => x.path).join(', ')}`);
  return lines.join('\n');
}

export default { snapshotTree, diffTrees, formatDiffBrief };
