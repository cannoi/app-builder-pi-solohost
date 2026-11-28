import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runValidationPipeline } from '../src/engineering/validation/pipeline.js';
import { STATUS } from '../src/engineering/validation/status.js';
import { secretScanProject } from '../src/engineering/diagnostics/secrets.js';
import { SnapshotStore } from '../src/projects/snapshots.js';

function mockDb() {
  const rows = [];
  return {
    run(...args) {
      if (String(args[0]).startsWith('INSERT')) {
        rows.unshift({
          id: args[1], project_id: args[2], reason: args[3], path: args[4], created_at: args[5],
        });
      }
      if (String(args[0]).startsWith('DELETE')) {
        const id = args[1];
        const i = rows.findIndex((r) => r.id === id);
        if (i >= 0) rows.splice(i, 1);
      }
    },
    all() { return rows.slice(); },
    get(sql, id, projectId) {
      return rows.find((r) => r.id === id && r.project_id === projectId) || null;
    },
  };
}

test('validation pipeline includes secret_scan step', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'v193-'));
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 't', version: '1.0.0', type: 'module' }));
  await fs.writeFile(path.join(dir, 'server.js'), 'export default 1;\n');
  const report = await runValidationPipeline(dir, { stopOnFail: false });
  assert.ok(report.steps.some((s) => s.id === 'code.secret_scan'));
  assert.ok(report.steps.some((s) => s.id === 'dare.check'));
});

test('secret scan on clean project is PASS or WARNING', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'v193s-'));
  await fs.writeFile(path.join(dir, 'package.json'), '{}');
  await fs.writeFile(path.join(dir, 'ok.js'), 'const x = 1;\n');
  const r = await secretScanProject(dir);
  assert.ok([STATUS.PASS, STATUS.WARNING, STATUS.NOT_AVAILABLE].includes(r.status));
});

test('snapshot retention keeps last N', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'v193snap-'));
  const projectsDir = path.join(root, 'projects');
  const slug = 'demo';
  const src = path.join(projectsDir, slug, 'source');
  await fs.mkdir(src, { recursive: true });
  await fs.writeFile(path.join(src, 'a.txt'), '1');
  const store = new SnapshotStore({
    cfg: { projectsDir, snapshotsKeep: 3 },
    db: mockDb(),
    log: console,
  });
  const project = { id: 'p1', slug };
  for (let i = 0; i < 5; i += 1) {
    await fs.writeFile(path.join(src, 'a.txt'), String(i));
    await store.create(project, `r${i}`);
  }
  assert.ok(store.list('p1').length <= 3);
});

test('create/improve/upgrade/import shadow hooks present in pipeline source', async () => {
  const text = await fs.readFile(new URL('../src/jobs/pipeline.js', import.meta.url), 'utf8');
  assert.match(text, /taskType: 'create'/);
  assert.match(text, /taskType: 'improve'/);
  assert.match(text, /taskType: 'upgrade'/);
  assert.match(text, /taskType: 'import'/);
  assert.match(text, /before-improve-eng/);
});
