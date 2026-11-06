import path from 'node:path';
import { ensureDir } from '../utils/fsx.js';
import { writeZip } from '../utils/zip.js';
import { stampMadeBy, verifyBadge } from './badge.js';

const SAFE_KINDS = new Set(['project', 'solohost']);

export async function createProjectZip({ sourceDir, outputDir, slug, kind = 'project', cfg = {} }) {
  if (!SAFE_KINDS.has(kind)) throw new Error('Unsupported export type.');
  await ensureDir(outputDir);
  // Safety net: the badge is stamped at every build/improve/import step already, but
  // if a project somehow reaches export without it (e.g. an older snapshot restored
  // directly to disk), enforce the mandatory badge rule here too before zipping.
  if (kind === 'project') {
    const hasBadge = await verifyBadge(sourceDir).catch(() => false);
    if (!hasBadge) await stampMadeBy(sourceDir, cfg).catch(() => {});
  }
  const zipName = `${slug}-${kind}.zip`;
  const zipPath = path.join(outputDir, zipName);
  const root = kind === 'solohost' ? path.join(sourceDir, 'solohost') : sourceDir;
  try {
    const result = await writeZip(root, zipPath);
    return { path: zipPath, filename: zipName, kind, files: result.files, bytes: result.bytes };
  } catch (err) {
    throw new Error(`Could not create ZIP: ${err.message}`);
  }
}
