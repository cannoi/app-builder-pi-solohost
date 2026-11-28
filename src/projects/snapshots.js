import fs from 'node:fs/promises';
import path from 'node:path';
import { copyDir, ensureDir, snapshotCopyFilter, listFiles, dirSizeBytes } from '../utils/fsx.js';
import { uuid } from '../utils/ids.js';
import { walkManifest } from '../engineering/checkpoints/store.js';

/** Snapshot reasons that retention must never delete (D-05). */
export const PROTECTED_SNAPSHOT_REASON = /^(after-generate|after-template-instantiate|release|manual|user|pre-rollback)/i;

export function isProtectedSnapshot(row) {
  const reason = String(row?.reason || '');
  return PROTECTED_SNAPSHOT_REASON.test(reason) || /(^|[-_])(release|manual|user)/i.test(reason);
}

export class SnapshotStore {
  constructor({ cfg, db, log }) {
    this.cfg = cfg;
    this.db = db;
    this.log = log;
  }

  async create(project, reason = 'manual') {
    const id = uuid();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(this.cfg.projectsDir, project.slug, 'snapshots', `${stamp}-${reason}`);
    const src = path.join(this.cfg.projectsDir, project.slug, 'source');
    await ensureDir(dest);
    await copyDir(src, dest, { filter: snapshotCopyFilter });
    try {
      const files = await listFiles(dest);
      // Manifest with hashes (checkpoints/store.js walkManifest) so restore/diff can verify content.
      const manifest = await walkManifest(dest).catch(() => []);
      await fs.writeFile(path.join(dest, '.snapshot-files.json'), JSON.stringify({ files, manifest: manifest.filter((m) => m.path !== '.snapshot-files.json'), reason, at: new Date().toISOString() }));
    } catch { /* non-fatal */ }
    this.db.run(
      'INSERT INTO snapshots(id,project_id,reason,path,created_at) VALUES(?,?,?,?,?)',
      id, project.id, reason, dest, new Date().toISOString(),
    );
    try { await this.pruneRetention(project.id, Number(this.cfg?.snapshotsKeep || 10)); } catch { /* ignore */ }
    return { id, path: dest, reason };
  }

  list(projectId) {
    return this.db.all(
      'SELECT * FROM snapshots WHERE project_id = ? ORDER BY created_at DESC',
      projectId,
    );
  }

  /**
   * Retention (D-05): never delete protected reasons (after-generate, release*, manual*, user*, pre-rollback)
   * or the very first snapshot (the original baseline); keep the newest snapshots up to `keep` in total
   * (at least one newest). Deletion is awaited and freed bytes are logged. Returns { removed, freedBytes }.
   * The return value is also usable as a number (removed count) for older callers.
   */
  async pruneRetention(projectId, keep = 10) {
    const rows = this.list(projectId);
    if (!Array.isArray(rows) || rows.length <= keep) return 0;
    const byAge = [...rows].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    const keepIds = new Set();
    for (const r of rows) if (isProtectedSnapshot(r)) keepIds.add(r.id);
    if (byAge[0]) keepIds.add(byAge[0].id);
    const newestBudget = Math.max(1, keep - keepIds.size);
    let added = 0;
    for (const r of rows) { // rows are newest first
      if (added >= newestBudget) break;
      if (!keepIds.has(r.id)) { keepIds.add(r.id); added += 1; }
    }
    let removed = 0;
    let freedBytes = 0;
    for (const row of rows) {
      if (keepIds.has(row.id)) continue;
      try {
        const size = await dirSizeBytes(row.path).catch(() => 0);
        await fs.rm(row.path, { recursive: true, force: true });
        this.db.run('DELETE FROM snapshots WHERE id = ?', row.id);
        freedBytes += size;
        removed += 1;
      } catch (err) {
        this.log?.warn?.('Snapshot retention could not delete a snapshot', { id: row.id, error: String(err?.message || err) });
      }
    }
    if (removed) this.log?.info?.('Snapshot retention', { projectId, removed, freedBytes });
    this.lastPrune = { removed, freedBytes };
    return removed;
  }

  async restore(project, snapshotId) {
    const row = this.db.get(
      'SELECT * FROM snapshots WHERE id = ? AND project_id = ?',
      snapshotId, project.id,
    );
    if (!row) throw new Error('Snapshot not found');
    const dest = path.join(this.cfg.projectsDir, project.slug, 'source');
    try {
      const pre = path.join(this.cfg.projectsDir, project.slug, 'snapshots', `pre-rollback-${Date.now()}`);
      await ensureDir(pre);
      await copyDir(dest, pre, { filter: snapshotCopyFilter });
    } catch { /* ignore */ }
    await copyDir(row.path, dest, { filter: snapshotCopyFilter });
    try {
      const raw = await fs.readFile(path.join(row.path, '.snapshot-files.json'), 'utf8');
      const { files: snapFiles } = JSON.parse(raw);
      const allowed = new Set((snapFiles || []).filter((f) => f !== '.snapshot-files.json'));
      const current = await listFiles(dest);
      for (const rel of current) {
        if (rel === '.snapshot-files.json') continue;
        if (!allowed.has(rel)) {
          await fs.unlink(path.join(dest, rel)).catch(() => {});
        }
      }
    } catch { /* old snapshots without manifest */ }
    return row;
  }
}
