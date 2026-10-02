import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectUpgrade, applyUpgrade, executeUpgradeRequest } from '../src/upgrade/engine.js';

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

function realSnapshots(root) {
  const backups = new Map();
  let sequence = 0;
  return {
    async create() {
      const id = `snap-${++sequence}`;
      const backup = `${root}-${id}`;
      await fs.cp(root, backup, { recursive: true });
      backups.set(id, backup);
      return { id, path: backup };
    },
    async restore(_project, id) {
      const backup = backups.get(id);
      if (!backup) throw new Error('Snapshot not found');
      await fs.rm(root, { recursive: true, force: true });
      await fs.cp(backup, root, { recursive: true });
    },
    async cleanup() {
      for (const backup of backups.values()) await fs.rm(backup, { recursive: true, force: true });
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

test('Upgrade preserves syntax failures in unchanged files in final verification', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-upgrade-existing-syntax-'));
  await fs.writeFile(path.join(root, 'index.html'), '<h1>Existing app</h1>');
  await fs.writeFile(path.join(root, 'legacy.js'), 'const = ;\n');
  const { project, projects, snapshots } = fakeProject(root);
  try {
    const inspected = await inspectUpgrade({ project, projects, snapshots, log: { info() {} } });
    assert.ok(inspected.issues.some((issue) => issue.id === 'syntax:legacy.js'));
    await applyUpgrade({
      project,
      projects,
      snapshots,
      request: 'Change the heading',
      plan: {
        risk: 'low',
        files: [{ path: 'index.html', content: '<h1>Updated app</h1>' }],
      },
    });
    const verification = await projects.readMetadata(project, 'test-plan.json', {});
    assert.equal(verification.verification.syntax.status, 'failed');
    assert.deepEqual(verification.verification.syntax.failedFiles, ['legacy.js']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Upgrade detects a broken router, retries from fresh syntax evidence, and applies without per-edit confirmation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-upgrade-router-syntax-'));
  await fs.mkdir(path.join(root, 'lib'), { recursive: true });
  const routerPath = path.join(root, 'lib', 'router.js');
  await fs.writeFile(routerPath, 'export function safeParseArray(value) { try { return JSON.parse(value); }\n');
  const { project, projects } = fakeProject(root);
  const snapshots = realSnapshots(root);
  try {
    const inspected = await inspectUpgrade({ project, projects, snapshots, log: { info() {} } });
    assert.ok(inspected.issues.some((issue) => issue.id === 'syntax:lib/router.js'));

    const plans = [
      {
        risk: 'high',
        root_cause: 'The parser function is still incomplete.',
        files: [{ path: 'lib/router.js', content: 'export function safeParseArray(value) { try {' }],
      },
      {
        risk: 'high',
        root_cause: 'The function needs a complete try/catch body.',
        files: [{
          path: 'lib\\router.js',
          content: 'export function safeParseArray(value) { try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; } }\n',
        }],
      },
    ];
    let aiCalls = 0;
    const result = await executeUpgradeRequest({
      project, projects, snapshots, request: 'Fix the router syntax and keep array parsing safe.',
      ai: { async completeJson() {
        if (aiCalls === 1) {
          assert.equal(await fs.readFile(routerPath, 'utf8'), 'export function safeParseArray(value) { try { return JSON.parse(value); }\n');
        }
        return { json: plans[aiCalls++] };
      } },
    });
    assert.equal(aiCalls, 2);
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.files, ['lib/router.js']);
    assert.match(await fs.readFile(routerPath, 'utf8'), /catch/);
    assert.equal(result.attempts, 2);
    const verification = await projects.readMetadata(project, 'test-plan.json', {});
    assert.deepEqual(verification.changedFiles, ['lib/router.js']);
    assert.equal(verification.verification.syntax.status, 'passed');
  } finally {
    await snapshots.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Upgrade refreshes stale source before applying the same plan', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-upgrade-stale-source-'));
  const indexPath = path.join(root, 'index.html');
  await fs.writeFile(indexPath, '<h1>Original</h1>');
  const { project, projects } = fakeProject(root);
  const snapshots = realSnapshots(root);
  let aiCalls = 0;
  try {
    await inspectUpgrade({ project, projects, snapshots, log: { info() {} } });
    const result = await executeUpgradeRequest({
      project, projects, snapshots, request: 'Change the heading',
      ai: { async completeJson() {
        if (aiCalls++ === 0) await fs.writeFile(indexPath, '<h1>External edit</h1>');
        return { json: { risk: 'high', files: [{ path: 'index.html', content: '<h1>Upgraded</h1>' }] } };
      } },
    });
    assert.equal(aiCalls, 2);
    assert.equal(result.status, 'completed');
    assert.equal(await fs.readFile(indexPath, 'utf8'), '<h1>Upgraded</h1>');
  } finally {
    await snapshots.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  }
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

test('Upgrade baseline catches SoloHost EACCES runtime permission even when source tests are otherwise healthy', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-upgrade-solohost-runtime-'));
  await fs.writeFile(path.join(root, 'Dockerfile'), 'FROM node:18-alpine\nWORKDIR /app\nCOPY . .\nUSER node\nCMD ["node","server.js"]\n');
  await fs.writeFile(path.join(root, 'server.js'), "const fs = require('fs'); fs.mkdirSync('/app/data', { recursive: true });\n");
  const { project, projects, snapshots } = fakeProject(root);
  const result = await inspectUpgrade({ project, projects, snapshots, log: { info() {} } });
  assert.equal(result.ready, true);
  assert.equal(result.safeRepairs.length >= 1, true);
  assert.equal(result.safeRepairs[0].ruleId, 'RUNTIME_FILESYSTEM_PERMISSION');
  const dockerfile = await fs.readFile(path.join(root, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /mkdir -p '\/app\/data' && chown 'node' '\/app\/data'/);
  assert.doesNotMatch(dockerfile, /chmod\s+(-R\s+)?777/);
  await fs.rm(root, { recursive: true, force: true });
});
