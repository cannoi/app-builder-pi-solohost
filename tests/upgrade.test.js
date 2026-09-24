import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectUpgrade, applyUpgrade } from '../src/upgrade/engine.js';

function fakeProject(root) {
  const meta = new Map();
  const project = { id: 'p1', slug: 'upgrade-test', name: 'Upgrade Test', version: '1.0.0' };
  return {
    project,
    projects: {
      sourceDir: () => root,
      projectDir: () => root,
      async saveMetadata(_p, name, data) { meta.set(name, data); },
      async readMetadata(_p, name, fallback = null) { return meta.has(name) ? meta.get(name) : fallback; },
    },
    snapshots: {
      async create() { return { id: 'snap-1', path: root, reason: 'test' }; },
      async restore() {},
    },
  };
}

test('Upgrade Workshop creates a baseline without changing a healthy app', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-upgrade-'));
  await fs.writeFile(path.join(root, 'index.html'), '<h1>Existing app</h1>');
  const { project, projects, snapshots } = fakeProject(root);
  const result = await inspectUpgrade({ project, projects, snapshots, log: { info() {} } });
  assert.equal(result.ready, true);
  assert.equal(result.baseline.fileCount, 1);
  assert.equal(result.baseline.sourceHash.length, 64);
  assert.equal((await fs.readFile(path.join(root, 'index.html'), 'utf8')), '<h1>Existing app</h1>');
  await fs.rm(root, { recursive: true, force: true });
});

test('Upgrade applies only the approved files and keeps low-risk scope', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-upgrade-'));
  await fs.writeFile(path.join(root, 'index.html'), '<h1>Existing app</h1>');
  const { project, projects, snapshots } = fakeProject(root);
  await inspectUpgrade({ project, projects, snapshots, log: { info() {} } });
  const result = await applyUpgrade({
    project,
    projects,
    snapshots,
    request: 'Change the heading',
    plan: {
      risk: 'low',
      root_cause: 'The heading is static in index.html.',
      recommendation: 'Change only the heading text.',
      files: [{ path: 'index.html', content: '<h1>Upgraded app</h1>' }],
      expected_result: 'Heading changes without affecting other features.',
    },
  });
  assert.deepEqual(result.files, ['index.html']);
  assert.equal(await fs.readFile(path.join(root, 'index.html'), 'utf8'), '<h1>Upgraded app</h1>');
  await fs.rm(root, { recursive: true, force: true });
});

test('Upgrade inspection appends history as an array', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-upgrade-hist-'));
  await fs.writeFile(path.join(root, 'index.html'), '<h1>Existing app</h1>');
  const { project, projects, snapshots } = fakeProject(root);
  await inspectUpgrade({ project, projects, snapshots, log: { info() {} } });
  const history = await projects.readMetadata(project, 'upgrade-history.json', []);
  assert.equal(Array.isArray(history), true);
  assert.equal(history[0].kind, 'inspect');
  await fs.rm(root, { recursive: true, force: true });
});

test('Upgrade rejects non-low-risk plans before modifying source', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-upgrade-'));
  await fs.writeFile(path.join(root, 'index.html'), '<h1>Existing app</h1>');
  const { project, projects, snapshots } = fakeProject(root);
  await assert.rejects(() => applyUpgrade({ project, projects, snapshots, request: 'Rewrite architecture', plan: { risk: 'high', files: [{ path: 'index.html', content: '<h1>bad</h1>' }] } }), /NEEDS_USER_ACTION/);
  assert.equal(await fs.readFile(path.join(root, 'index.html'), 'utf8'), '<h1>Existing app</h1>');
  await fs.rm(root, { recursive: true, force: true });
});
