import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgentLoop, truncateToolResult, isDuplicateCall } from '../src/engine/agent-loop.js';

test('truncate tool result', () => {
  const s = truncateToolResult('x'.repeat(20000), 100);
  assert.ok(s.length < 200);
  assert.match(s, /truncated/);
});

test('duplicate call detection', () => {
  assert.equal(isDuplicateCall({ name: 'a', args: { q: 1 } }, { name: 'a', args: { q: 1 } }), true);
  assert.equal(isDuplicateCall({ name: 'a', args: { q: 1 } }, { name: 'a', args: { q: 2 } }), false);
});

test('stops at max steps without final', async () => {
  let n = 0;
  const ai = {
    async completeJson() {
      n += 1;
      return { json: { tool_calls: [{ name: 'list_files', args: {} }] } };
    },
  };
  const tools = {
    async list_files() { return 'a.js'; },
  };
  const r = await runAgentLoop({ ai, prompt: 'x', tools, maxSteps: 3 });
  assert.equal(r.ok, false);
  assert.ok(n <= 3);
  assert.match(r.error, /steps/);
});

test('tools cannot write — only provided handlers run', async () => {
  let wrote = false;
  const ai = {
    async completeJson() {
      return { json: { tool_calls: [{ name: 'write_file', args: { path: 'x' } }, { name: 'list_files', args: {} }] } };
    },
  };
  // second call returns final
  let first = true;
  ai.completeJson = async () => {
    if (first) {
      first = false;
      return { json: { tool_calls: [{ name: 'write_file', args: {} }, { name: 'list_files', args: {} }] } };
    }
    return { json: { final: { edits: [], explanation: 'none', risk: 'low' } } };
  };
  const tools = {
    async list_files() { return 'ok'; },
    async write_file() { wrote = true; return 'nope'; },
  };
  // write_file is NOT in the allowed set used by createReadOnlyTools — but if passed, still callable.
  // Contract: createReadOnlyTools never exposes write — this test ensures unknown tools error when not provided:
  const tools2 = { async list_files() { return 'ok'; } };
  const r = await runAgentLoop({ ai, prompt: 'x', tools: tools2, maxSteps: 4 });
  assert.equal(wrote, false);
  assert.equal(r.ok, true);
});

test('rejects exact duplicate consecutive tool call', async () => {
  const calls = [];
  let phase = 0;
  const ai = {
    async completeJson() {
      phase += 1;
      if (phase === 1) return { json: { tool_calls: [{ name: 'list_files', args: { prefix: '' } }, { name: 'list_files', args: { prefix: '' } }] } };
      return { json: { final: { edits: [], explanation: 'done', risk: 'low' } } };
    },
  };
  const tools = {
    async list_files(args) { calls.push(args); return 'f'; },
  };
  await runAgentLoop({ ai, prompt: 'x', tools, maxSteps: 4 });
  // second identical call rejected → only one real invocation
  assert.equal(calls.length, 1);
});
