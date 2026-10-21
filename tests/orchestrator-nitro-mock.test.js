/**
 * Benchmark: Nitro Shootout + "add LAN multiplayer" with mocked AI.
 * Asserts planner complexity, feasibility awareness, task count, and agent history P0.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { classifyComplexity } from '../src/orchestrator/router.js';
import { fallbackPlan, validatePlan, planWithAi } from '../src/orchestrator/planner.js';
import { runOrchestrator, formatPlanCard } from '../src/orchestrator/index.js';
import { runAgentLoop } from '../src/engine/agent-loop.js';
import { buildChecklist, evaluateChecklist } from '../src/engine/checklist.js';
import { allowTaskScopedRepair } from '../src/agent/scope-guard.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const nitroZip = '/home/workdir/attachments/nitro-shootout-project.zip';

test('LAN multiplayer request is complex and checklist has multiplayer items', () => {
  const req = 'add LAN multiplayer with lobby so two phones can play';
  assert.equal(classifyComplexity({ request: req }).level, 'complex');
  const cl = buildChecklist(req);
  assert.ok(cl.some((i) => i.id.startsWith('mp-')), cl.map((i) => i.id).join(','));
});

test('planner fallback yields ≥1 task; mock AI can yield ≥4', async () => {
  const req = 'add LAN multiplayer: rooms, client sync, lobby UI, tests';
  const fb = fallbackPlan(req);
  assert.ok(validatePlan(fb).ok);
  const ai = {
    async completeJson() {
      return {
        json: {
          goal: req,
          feasibility: {
            ok: false,
            conflicts: [
              {
                what: 'LAN access vs 127.0.0.1 SoloHost bind',
                options: ['SSE on same host for co-op', 'Document that LAN needs host network (not SoloHost default)'],
                recommended: 'SSE on published UI port with same-origin clients',
              },
            ],
            assumptions: [],
          },
          decisions: [{ topic: 'transport', choice: 'SSE+POST', why: 'zero dependency' }],
          tasks: [
            { id: 'T1', title: 'Server rooms', goal: 'room API', files_expected: ['server.js'], depends_on: [], acceptance: [{ type: 'grep', spec: 'room' }], risk: 'medium', rollback: 'task' },
            { id: 'T2', title: 'Client net', goal: 'join room', files_expected: ['public/game.js'], depends_on: ['T1'], acceptance: [{ type: 'grep', spec: 'join' }], risk: 'medium', rollback: 'task' },
            { id: 'T3', title: 'Lobby UI', goal: 'lobby screen', files_expected: ['public/index.html'], depends_on: ['T2'], acceptance: [{ type: 'grep', spec: 'lobby' }], risk: 'low', rollback: 'task' },
            { id: 'T4', title: 'Tests', goal: 'smoke', files_expected: ['tests/'], depends_on: ['T1'], acceptance: [{ type: 'node-check', spec: 'ok' }], risk: 'low', rollback: 'none' },
          ],
        },
      };
    },
  };
  const r = await planWithAi({ ai, request: req, lang: 'en' });
  assert.ok(r.ok);
  assert.ok(r.plan.tasks.length >= 4);
  assert.equal(r.plan.feasibility.ok, false);
  assert.ok(r.plan.feasibility.conflicts.length >= 1);
});

test('orchestrator surfaces feasibility question once for LAN conflict', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nitro-orch-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"nitro","type":"module"}\n');
  const ai = {
    async completeJson({ task }) {
      if (task === 'ORCHESTRATOR_PLAN') {
        return {
          json: {
            goal: 'LAN multiplayer',
            feasibility: {
              ok: false,
              conflicts: [{ what: 'LAN vs 127.0.0.1', options: ['SSE same-origin'], recommended: 'SSE' }],
              assumptions: [],
            },
            decisions: [],
            tasks: [
              { id: 'T1', title: 'x', goal: 'x', files_expected: [], depends_on: [], acceptance: [{ type: 'node-check', spec: 'ok' }], risk: 'low', rollback: 'none' },
            ],
          },
        };
      }
      return { json: { final: { edits: [], explanation: '', risk: 'low' } } };
    },
  };
  const out = await runOrchestrator({
    ai,
    projectDir: dir,
    request: 'add LAN multiplayer for two devices',
    lang: 'en',
  });
  assert.equal(out.used, true);
  assert.equal(out.needsUser, true);
  assert.ok(out.question?.what || out.question?.en);
});

test('P8 task-scoped repair allowed in upgrade phase', async () => {
  assert.equal(allowTaskScopedRepair('upgrade', 'taskRepair'), true);
  const { assertPhaseAllows } = await import('../src/agent/scope-guard.js');
  assert.throws(() => assertPhaseAllows('upgrade', 'runDare'), /UPGRADE_SCOPE_VIOLATION/);
  assert.doesNotThrow(() => assertPhaseAllows('upgrade', 'taskRepair', { taskScoped: true }));
});

test('formatPlanCard is compact bilingual-ready', () => {
  const card = formatPlanCard(
    {
      tasks: [
        { id: 'T1', title: 'Server' },
        { id: 'T2', title: 'Client' },
      ],
    },
    { T1: { status: 'done' }, T2: { status: 'running' } },
    'en',
  );
  assert.match(card, /✅ T1/);
  assert.match(card, /⏳ T2/);
});

test('P0 still holds under multi-step mock multiplayer tools', async () => {
  const seen = [];
  const ai = {
    n: 0,
    async completeJson({ prompt }) {
      seen.push(prompt);
      this.n += 1;
      if (this.n === 1) return { json: { tool_calls: [{ name: 'read_file', args: { path: 'server.js' } }] } };
      assert.match(prompt, /createRoom/);
      return { json: { final: { edits: [], explanation: 'seen server', risk: 'low' } } };
    },
  };
  await runAgentLoop({
    ai,
    prompt: 'add rooms',
    tools: {
      async read_file() {
        return 'function createRoom(){ return 1 }';
      },
    },
  });
  assert.ok(seen.length >= 2);
});
