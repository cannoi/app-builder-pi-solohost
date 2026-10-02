import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createUpgradeSession, updateUpgradeSession, pauseUpgradeSession, resumeUpgradeSession } from '../src/upgrade/session.js';

test('upgrade session persists plan progress and remains resumable after provider interruption', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-upgrade-session-'));
  const project = { slug: 'demo' };
  const projects = {
    async saveMetadata(p, name, value) { await fs.writeFile(path.join(root, name), JSON.stringify(value)); },
    async readMetadata(p, name, fallback) { try { return JSON.parse(await fs.readFile(path.join(root, name), 'utf8')); } catch { return fallback; } },
  };
  const created = await createUpgradeSession(projects, project, {
    sourceCommit: 'abc123', request: 'add AI chat', baselineHash: 'base-hash',
    steps: [{ id: 'diagnose', label: 'Diagnose' }, { id: 'apply', label: 'Apply' }, { id: 'verify', label: 'Verify' }],
  });
  assert.equal(created.status, 'running');
  assert.equal(created.sourceCommit, 'abc123');
  assert.equal(created.currentStep, 'diagnose');

  const progressed = await updateUpgradeSession(projects, project, {
    currentStep: 'apply', completedSteps: ['diagnose'], changedFiles: ['server.js'],
    checkpoints: ['checkpoint-1'], phase: 'apply', planHash: 'plan-hash',
  });
  assert.deepEqual(progressed.completedSteps, ['diagnose']);
  assert.deepEqual(progressed.changedFiles, ['server.js']);
  assert.deepEqual(progressed.checkpoints, ['checkpoint-1']);

  const paused = await pauseUpgradeSession(projects, project, { code: 'PAUSED_AI_UNAVAILABLE', message: '429 rate limit' });
  assert.equal(paused.status, 'paused');
  assert.equal(paused.resumable, true);
  assert.equal(paused.currentStep, 'apply');

  const resumed = await resumeUpgradeSession(projects, project);
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.resumable, true);
  assert.equal(resumed.sourceCommit, 'abc123');
  assert.equal(resumed.currentStep, 'apply');
  assert.deepEqual(resumed.completedSteps, ['diagnose']);
  assert.deepEqual(resumed.changedFiles, ['server.js']);
  await fs.rm(root, { recursive: true, force: true });
});
