import path from 'node:path';
import fs from 'node:fs/promises';
import { copyDir, ensureDir } from '../utils/fsx.js';
import { uuid } from '../utils/ids.js';

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
    await copyDir(src, dest);
    this.db.run(
      'INSERT INTO snapshots(id,project_id,reason,path,created_at) VALUES(?,?,?,?,?)',
      id, project.id, reason, dest, new Date().toISOString(),
    );
    return { id, path: dest, reason };
  }

  list(projectId) {
    return this.db.all(
      'SELECT * FROM snapshots WHERE project_id = ? ORDER BY created_at DESC',
      projectId,
    );
  }

  async restore(project, snapshotId) {
    const row = this.db.get(
      'SELECT * FROM snapshots WHERE id = ? AND project_id = ?',
      snapshotId, project.id,
    );
    if (!row) throw new Error('Snapshot not found');
    const dest = path.join(this.cfg.projectsDir, project.slug, 'source');
    const staging = path.join(path.dirname(dest), `.source-restore-${uuid()}`);
    const backup = path.join(path.dirname(dest), `.source-backup-${uuid()}`);
    let movedCurrent = false;
    try {
      await copyDir(row.path, staging);
      try {
        await fs.rename(dest, backup);
        movedCurrent = true;
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      await fs.rename(staging, dest);
    } catch (err) {
      if (movedCurrent) {
        await fs.rename(backup, dest).catch((rollbackErr) => {
          throw new Error(`Snapshot restore failed (${String(err.message || err)}); preserving current source also failed (${String(rollbackErr.message || rollbackErr)}).`);
        });
      }
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
    if (movedCurrent) await fs.rm(backup, { recursive: true, force: true });
    return row;
  }
}
