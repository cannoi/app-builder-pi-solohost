import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeadline, BUDGET_MS } from '../src/core/budget.js';
import { buildAttemptPlan, DEFAULT_PROVIDER_PRIORITY, ROUTING_MODE } from '../src/ai/hub/routing.js';
import { classifyComplexity } from '../src/orchestrator/router.js';
import { buildPanelKnowledge } from '../src/ai/panel-knowledge.js';
import { JobQueue } from '../src/jobs/queue.js';

test('deadline aborts after ms', async () => {
  const d = createDeadline({ ms: 30, label: 't' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(d.signal.aborted, true);
});

test('Auto plan: Gemini before DeepSeek even if DeepSeek listed first', () => {
  const plan = buildAttemptPlan({
    connections: [
      { id: '1', provider: 'deepseek', hasKey: true, status: 'VERIFIED', models: [{ id: 'deepseek-chat', verified: true }] },
      { id: '2', provider: 'gemini', hasKey: true, status: 'VERIFIED', models: [{ id: 'gemini-2.0-flash', verified: true }] },
    ],
    mode: ROUTING_MODE.AUTO,
    preferredModels: [],
    maxAttempts: 3,
  });
  assert.ok(plan.length >= 1);
  assert.equal(plan[0].conn.provider, 'gemini');
});

test('user-selected model beats Auto', () => {
  const plan = buildAttemptPlan({
    connections: [
      { id: '1', provider: 'deepseek', hasKey: true, status: 'VERIFIED', models: [{ id: 'deepseek-chat' }] },
      { id: '2', provider: 'gemini', hasKey: true, status: 'VERIFIED', models: [{ id: 'gemini-2.0-flash' }] },
    ],
    mode: ROUTING_MODE.SELECTED,
    preferredModels: ['deepseek:deepseek-chat'],
    maxAttempts: 3,
  });
  assert.equal(plan[0].model, 'deepseek-chat');
});

test('default provider priority starts with gemini', () => {
  assert.equal(DEFAULT_PROVIDER_PRIORITY[0], 'gemini');
});

test('router: login alone is trivial; multiplayer is complex', () => {
  assert.equal(classifyComplexity({ request: 'fix login button color' }).level, 'trivial');
  assert.equal(classifyComplexity({ request: 'add LAN multiplayer with lobby' }).level, 'complex');
});

test('panel knowledge mentions gemini default', () => {
  const en = buildPanelKnowledge({ lang: 'en' });
  const vi = buildPanelKnowledge({ lang: 'vi' });
  assert.match(en, /gemini/i);
  assert.match(vi, /gemini/i);
  assert.doesNotMatch(en, /DeepSeek is the default/i);
});

test('cancel is terminal and clears active', async () => {
  // minimal mock db
  const rows = new Map();
  const events = [];
  const db = {
    run(...args) {
      const sql = String(args[0] || '');
      if (sql.startsWith('INSERT INTO jobs')) {
        const id = args[1];
        rows.set(id, { id, status: 'queued', project_id: args[2], type: args[3] });
      } else if (sql.startsWith('UPDATE jobs SET status')) {
        const status = args[1];
        const id = args[args.length - 1];
        const row = rows.get(id) || { id };
        row.status = status;
        if (sql.includes('error')) row.error = args[2];
        rows.set(id, row);
      } else if (sql.startsWith('INSERT INTO job_events')) {
        events.push(args);
      }
    },
    get(sql, id) {
      return rows.get(id) || null;
    },
    all() {
      return [];
    },
  };
  const q = new JobQueue({ db, log: { warn() {}, info() {} } });
  q.on('noop', async () => {
    await new Promise((r) => setTimeout(r, 5000));
    return { ok: true };
  });
  const job = q.enqueue({ type: 'noop', projectId: 'p1' });
  const kickP = q.kick(job);
  await new Promise((r) => setTimeout(r, 10));
  q.requestCancel(job.id);
  await kickP.catch(() => {});
  const final = rows.get(job.id);
  assert.equal(final.status, 'cancelled');
  assert.equal(q.isBusy('p1'), false);
});
