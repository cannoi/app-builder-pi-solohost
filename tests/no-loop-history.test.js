import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { shouldBlockRepeatedAction, repairFingerprint } from '../src/jobs/loop-guard.js';
import { fingerprintError } from '../src/dare/fingerprint.js';
import { mergeVerificationState } from '../src/jobs/verification.js';
import { openDb } from '../src/storage/db.js';
import { ProjectManager } from '../src/projects/manager.js';

test('repeat guard blocks the same failed action after one automatic attempt in a short window', () => {
  const now = Date.now();
  const history = { fingerprint: 'release-tests-failed', attempts: 2, lastAt: new Date(now - 60_000).toISOString() };
  assert.equal(shouldBlockRepeatedAction(history, 'release-tests-failed', now, 10 * 60_000, 1), true);
  assert.equal(shouldBlockRepeatedAction(history, 'different-failure', now, 10 * 60_000, 2), false);
  assert.equal(shouldBlockRepeatedAction(history, 'release-tests-failed', now + 11 * 60_000, 10 * 60_000, 1), false);
});


test('repair fingerprint follows the concrete runtime error, not changing user wording', () => {
  const runtime = { error: "Error: EACCES: permission denied, mkdir '/app/data'", logs: '' };
  assert.equal(repairFingerprint({ feedback: 'app chạy bị lỗi -> chạy', runtime }), 'RUNTIME_FILESYSTEM_PERMISSION:/app/data');
  assert.equal(repairFingerprint({ feedback: 'fix lỗi quyền thư mục', runtime }), 'RUNTIME_FILESYSTEM_PERMISSION:/app/data');
  assert.equal(fingerprintError(runtime.error), 'RUNTIME_FILESYSTEM_PERMISSION:/app/data');
});
test('verification after Improve replaces stale test results used by Publish', () => {
  const old = { staticResult: { status: 'passed' }, nodeResult: { status: 'failed', error: 'old' }, preview: { status: 'passed' } };
  const fresh = { staticResult: { status: 'passed' }, nodeResult: { status: 'passed' }, scan: { critical: 0 }, dockerBuild: { status: 'passed' }, e2e: { status: 'passed' } };
  const next = mergeVerificationState(old, fresh);
  assert.equal(next.nodeResult.status, 'passed');
  assert.equal(next.dockerBuild.status, 'passed');
  assert.equal(next.scan.critical, 0);
  assert.equal(next.e2e.status, 'passed');
});

test('project work history persists across Builder sessions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-history-'));
  const db = openDb(path.join(root, 'data'));
  const cfg = { projectsDir: path.join(root, 'projects'), workspaceDir: root, maxProjectSizeMb: 80, ai: { provider: 'deepseek' } };
  const make = () => new ProjectManager({ cfg, db, log: { warn() {} }, snapshots: {} });
  const projects = make();
  const project = await projects.create({ idea: 'History test', name: 'History test', analysis: {}, plan: {} });
  await projects.recordWorkHistory(project, { id: 'job-1', type: 'improve', status: 'done', summary: 'Patched button and verified preview.' });
  const again = make();
  const history = await again.workHistory(project);
  assert.equal(history.length, 1);
  assert.equal(history[0].summary, 'Patched button and verified preview.');
  db.close();
  await fs.rm(root, { recursive: true, force: true });
});
