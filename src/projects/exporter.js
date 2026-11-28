import path from 'node:path';
import { ensureDir } from '../utils/fsx.js';
import { writeZip } from '../utils/zip.js';
import { stampMadeBy, verifyBadge, isMadeByEnabled } from './badge.js';

const SAFE_KINDS = new Set(['project', 'solohost']);

export async function createProjectZip({ sourceDir, outputDir, slug, kind = 'project', cfg = {} }) {
  if (!SAFE_KINDS.has(kind)) throw new Error('Unsupported export type.');
  await ensureDir(outputDir);
  if (kind === 'project') {
    if (!isMadeByEnabled(cfg)) {
      await stampMadeBy(sourceDir, cfg).catch(() => {});
    } else {
      const hasBadge = await verifyBadge(sourceDir, cfg).catch(() => false);
      if (!hasBadge) await stampMadeBy(sourceDir, cfg).catch(() => {});
    }
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
