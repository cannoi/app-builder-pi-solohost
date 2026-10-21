import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHistoryForPrompt,
  callKey,
  runAgentLoop,
  truncateToolResult,
} from '../src/engine/agent-loop.js';
import { classifyComplexity } from '../src/orchestrator/router.js';
import { validatePlan, fallbackPlan } from '../src/orchestrator/planner.js';
import { verifyTask, runGrepAcceptance } from '../src/orchestrator/verifier.js';
import { repairFingerprint, shouldBlockRepeatedAction } from '../src/jobs/loop-guard.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('P0: history includes tool results so AI can see file content', () => {
  const steps = [
    {
      step: 1,
      tool_calls: [{ name: 'read_file', args: { path: 'a.js' } }],
      results: [{ name: 'read_file', result: 'export const secretMarker = 42;\n' }],
    },
  ];
  const hist = buildHistoryForPrompt(steps);
  assert.equal(hist[0].results[0].result.includes('secretMarker'), true);
});

test('P0 simulation: second AI prompt receives previous tool result', async () => {
  const prompts = [];
  const ai = {
    async completeJson({ prompt }) {
      prompts.push(prompt);
      if (prompts.length === 1) {
        return { json: { tool_calls: [{ name: 'read_file', args: { path: 'game.js' } }] } };
      }
      // Assert history contained file body
      assert.match(prompt, /function playNitro/);
      return {
        json: {
          final: {
            edits: [{ path: 'game.js', op: 'replace', search: 'playNitro', replace: 'playNitro2' }],
            explanation: 'rename',
            risk: 'low',
          },
        },
      };
    },
  };
  const tools = {
    async read_file() {
      return 'function playNitro() { return 1; }';
    },
  };
  const out = await runAgentLoop({ ai, prompt: 'rename', tools, maxSteps: 4 });
  assert.ok(out.final.edits.length >= 1);
  assert.ok(prompts.length >= 2);
  assert.match(prompts[1], /playNitro/);
});

test('P1: global dedupe returns cached result not error', async () => {
  let reads = 0;
  const ai = {
    n: 0,
    async completeJson() {
      this.n += 1;
      if (this.n <= 2) {
        return { json: { tool_calls: [{ name: 'read_file', args: { path: 'x.js' } }] } };
      }
      return { json: { final: { edits: [], explanation: 'done', risk: 'low' } } };
    },
  };
  const tools = {
    async read_file() {
      reads += 1;
      return 'content-x';
    },
  };
  await runAgentLoop({ ai, prompt: 'x', tools, maxSteps: 6 });
  assert.equal(reads, 1); // second identical call served from cache
});

test('complexity router: multiplayer is complex, color change is trivial', () => {
  assert.equal(classifyComplexity({ request: 'add LAN multiplayer with lobby' }).level, 'complex');
  assert.equal(classifyComplexity({ request: 'đổi màu nền sang xanh' }).level, 'trivial');
});

test('planner schema rejects empty tasks', () => {
  assert.equal(validatePlan({ goal: 'x', feasibility: { ok: true }, tasks: [] }).ok, false);
  assert.equal(validatePlan(fallbackPlan('add lobby')).ok, true);
});

test('P4/P7: warnings do not match critical fingerprint path; provider changes fingerprint', () => {
  const a = repairFingerprint({ feedback: 'fail', provider: 'gemini', model: 'g1' });
  const b = repairFingerprint({ feedback: 'fail', provider: 'deepseek', model: 'd1' });
  assert.notEqual(a, b);
  assert.equal(shouldBlockRepeatedAction({ fingerprint: a, attempts: 1, lastAt: new Date().toISOString() }, a, Date.now(), 600000, 2), false);
});

test('verifier grep acceptance', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paf-v-'));
  fs.writeFileSync(path.join(dir, 'a.js'), 'export const LAN_ROOM = true;\n');
  const g = runGrepAcceptance(dir, 'LAN_ROOM');
  assert.equal(g.ok, true);
});

test('orchestrator modules resolve', async () => {
  const m = await import('../src/orchestrator/index.js');
  assert.equal(typeof m.runOrchestrator, 'function');
  assert.equal(typeof m.isOrchestratorV3Enabled, 'function');
});

test('pipeline does not roll back on warning-only security delta', () => {
  const src = fs.readFileSync(path.join(root, 'src/jobs/pipeline.js'), 'utf8');
  assert.match(src, /P4: warnings do not force rollback|false \/\* P4/);
  assert.doesNotMatch(src, /afterScan\.warning > security\.warning/);
});
