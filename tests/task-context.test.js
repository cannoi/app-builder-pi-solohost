import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTaskContext,
  runWithTaskContext,
  getActiveTaskContext,
  appendTaskEvent,
  updateTaskProgress,
  compactTaskContext,
  buildTaskContextBlock,
  applyTaskContextToSystem,
  closeTaskContext,
  enterTaskContext,
} from '../src/agent/task-context.js';

test('create and isolate task contexts between concurrent runs', async () => {
  const a = createTaskContext({ taskType: 'CREATE', originalRequest: 'app A', projectId: 'a' });
  const b = createTaskContext({ taskType: 'IMPROVE', originalRequest: 'app B', projectId: 'b' });
  const results = await Promise.all([
    runWithTaskContext(a, async () => {
      updateTaskProgress({ technicalDecisions: ['use sqlite'] });
      appendTaskEvent({ type: 'note', summary: 'A decision' });
      return getActiveTaskContext().sessionId;
    }),
    runWithTaskContext(b, async () => {
      updateTaskProgress({ technicalDecisions: ['use memory'] });
      return getActiveTaskContext().sessionId;
    }),
  ]);
  assert.notEqual(results[0], results[1]);
  assert.equal(getActiveTaskContext(), null);
});

test('compaction preserves original request and decisions', () => {
  const ctx = createTaskContext({ taskType: 'IMPROVE', originalRequest: 'add cart and totals' });
  runWithTaskContext(ctx, () => {
    updateTaskProgress({
      completedTasks: ['analyze'],
      technicalDecisions: ['keep /health', 'cart in memory'],
      modifiedFiles: ['public/index.html', 'server.js'],
      detectedErrors: ['api_ui_field_mismatch'],
    });
    for (let i = 0; i < 5; i++) appendTaskEvent({ type: 'ai_complete', task: 'CODING', summary: `step ${i}` });
    const compact = compactTaskContext();
    assert.equal(compact.originalRequest, 'add cart and totals');
    assert.ok(compact.technicalDecisions.includes('keep /health'));
    assert.ok(compact.modifiedFiles.includes('server.js'));
    const block = buildTaskContextBlock();
    assert.match(block, /PERSISTENT TASK CONTEXT/);
    assert.match(block, /add cart and totals/);
    const sys = applyTaskContextToSystem('You are a coder.');
    assert.match(sys, /PERSISTENT TASK CONTEXT/);
    assert.match(sys, /You are a coder/);
    // idempotent second apply
    const sys2 = applyTaskContextToSystem(sys);
    assert.equal(sys2, sys);
    closeTaskContext({ status: 'completed', summary: 'done' });
    assert.equal(getActiveTaskContext().status, 'completed');
  });
});

test('gateway complete injects task context into system (mocked hub)', async () => {
  // Avoid constructing full AIGateway (needs db.setting); exercise the same injection path.
  const ctx = createTaskContext({ taskType: 'CREATE', originalRequest: 'milk tea shop with cart' });
  await runWithTaskContext(ctx, async () => {
    updateTaskProgress({ technicalDecisions: ['menu+cart'] });
    const systemWithTask = applyTaskContextToSystem('SYSTEM_BASE');
    assert.match(systemWithTask, /SYSTEM_BASE/);
    assert.match(systemWithTask, /PERSISTENT TASK CONTEXT/);
    assert.match(systemWithTask, /milk tea shop with cart/);
    assert.match(systemWithTask, /menu\+cart/);
    // Simulate gateway post-success event append
    appendTaskEvent({ type: 'ai_complete', task: 'CODING', provider: 'mock', model: 'mock-1', summary: 'ok', ok: true });
    assert.ok(getActiveTaskContext().events.some((e) => e.type === 'ai_complete'));
  });
});

test('enterTaskContext binds without run() wrapper', async () => {
  const ctx = createTaskContext({ taskType: 'UPGRADE', originalRequest: 'upgrade flow' });
  enterTaskContext(ctx);
  assert.equal(getActiveTaskContext()?.taskType, 'UPGRADE');
  appendTaskEvent({ type: 'upgrade_session', summary: 'started' });
  assert.ok(getActiveTaskContext().events.length >= 1);
});

test('provider-agnostic: same context block regardless of provider field', () => {
  const ctx = createTaskContext({ taskType: 'BUILD', originalRequest: 'x', provider: 'gemini' });
  let blockG;
  runWithTaskContext(ctx, () => {
    updateTaskProgress({ provider: 'deepseek', model: 'ds-1' });
    blockG = buildTaskContextBlock();
  });
  assert.match(blockG, /deepseek/);
  assert.match(blockG, /ds-1/);
});
