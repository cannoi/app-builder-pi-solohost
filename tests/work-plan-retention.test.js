import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/storage/db.js';
import { ProjectManager } from '../src/projects/manager.js';

test('work plans persist step reports and chat retention removes entries older than 30 days', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-plan-'));
  const db = openDb(path.join(root, 'data'));
  const projects = new ProjectManager({
    cfg: { projectsDir: path.join(root, 'projects'), workspaceDir: root, maxProjectSizeMb: 80, ai: { provider: 'deepseek' } },
    db,
    log: { warn() {} },
    snapshots: {},
  });
  const project = await projects.create({ idea: 'Plan test', name: 'Plan test', analysis: {}, plan: {} });
  const plan = await projects.startWorkPlan(project, {
    jobId: 'job-1',
    message: 'Change the button, then verify it.',
    steps: [{ action: 'improve', goal: 'Change the button' }, { action: 'run', goal: 'Verify it' }],
  });
  await projects.updateWorkPlan(project, { stepId: plan.steps[0].id, step: { status: 'done', files: ['public/app.js'] }, reports: [{ status: 'done' }] });
  await projects.finishWorkPlan(project, 'done', 'Continue from the saved report.');
  const saved = await projects.readMetadata(project, 'work-plan.json', {});
  assert.equal(saved.status, 'done');
  assert.deepEqual(saved.steps[0].files, ['public/app.js']);
  assert.equal(saved.handoff, 'Continue from the saved report.');

  const chatFile = path.join(projects.projectDir(project), 'metadata', 'chat.json');
  await fs.writeFile(chatFile, JSON.stringify([
    { id: 'old', role: 'user', message: 'old', createdAt: '2020-01-01T00:00:00.000Z' },
    { id: 'new', role: 'user', message: 'new', createdAt: new Date().toISOString() },
  ]));
  await projects.pruneRetention();
  const chat = await projects.chatHistory(project);
  assert.deepEqual(chat.map((entry) => entry.id), ['new']);
  db.close();
  await fs.rm(root, { recursive: true, force: true });
});