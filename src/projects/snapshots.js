import path from 'node:path';
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
    await copyDir(row.path, dest);
    return row;
  }
}
