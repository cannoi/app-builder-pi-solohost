import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/storage/db.js';
import { SnapshotStore } from '../src/projects/snapshots.js';

test('snapshot restore removes files added after the checkpoint', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-snapshot-restore-'));
  const projectsDir = path.join(root, 'projects');
  const source = path.join(projectsDir, 'demo', 'source');
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, 'app.js'), 'old source');
  const db = openDb(path.join(root, 'data'));
  const snapshots = new SnapshotStore({ cfg: { projectsDir }, db, log: { warn() {} } });
  const project = { id: 'project-1', slug: 'demo' };
  const checkpoint = await snapshots.create(project, 'before-change');
  await fs.writeFile(path.join(source, 'app.js'), 'changed source');
  await fs.writeFile(path.join(source, 'new-file.js'), 'unverified file');
  await snapshots.restore(project, checkpoint.id);
  assert.equal(await fs.readFile(path.join(source, 'app.js'), 'utf8'), 'old source');
  await assert.rejects(() => fs.access(path.join(source, 'new-file.js')));
  db.close();
  await fs.rm(root, { recursive: true, force: true });
});
