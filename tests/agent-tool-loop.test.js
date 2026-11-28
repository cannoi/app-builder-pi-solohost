import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runToolAgentLoop } from '../src/agent/tool-loop.js';
import { runAgentTools } from '../src/ai/agent-tools.js';

test('Agent loop continues after tool evidence and returns final model plan', async () => {
  let calls = 0;
  const memory = [];
  const loop = await runToolAgentLoop({
    prompt: 'inspect project',
    callModel: async ({ prompt }) => {
      calls += 1;
      if (calls === 1) return { json: { files: [], tool_actions: [{ tool: 'list_files' }] }, provider: 'mock' };
      assert.match(prompt, /AGENT TOOL HISTORY/);
      assert.match(prompt, /package\.json/);
      return { json: { files: [], recommendation: 'No changes required', expected_result: 'unchanged' }, provider: 'mock' };
    },
    executeTools: async () => [{ tool: 'list_files', ok: true, files: ['package.json'] }],
    onMemory: async (value) => memory.push(value),
  });
  assert.equal(calls, 2);
  assert.equal(loop.toolCalls, 1);
  assert.equal(loop.result.json.recommendation, 'No changes required');
  assert.ok(memory.some((m) => m.evidence?.length));
});

test('Agent loop blocks a repeated identical tool batch and performs final synthesis', async () => {
  let calls = 0;
  const loop = await runToolAgentLoop({
    prompt: 'inspect project',
    callModel: async () => {
      calls += 1;
      return calls <= 2
        ? { json: { files: [], tool_actions: [{ tool: 'list_files' }] } }
        : { json: { files: [], recommendation: 'Stopped safely', expected_result: 'needs more detail' } };
    },
    executeTools: async () => [{ tool: 'list_files', ok: true, files: [] }],
  });
  assert.equal(loop.stopped, true);
  assert.equal(loop.stopReason, 'repeated_tool_batch');
  assert.equal(loop.toolCalls, 1);
  assert.equal(loop.result.json.recommendation, 'Stopped safely');
});

test('Agent file tools reject symlink escapes and can inspect package metadata', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-agent-tools-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-agent-outside-'));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'demo', version: '1.2.3', scripts: { test: 'node --test' } }));
  await fs.writeFile(path.join(outside, 'secret.txt'), 'private');
  await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'secret.txt'));
  const results = await runAgentTools({ sourceDir: root, actions: [
    { tool: 'inspect_package' }, { tool: 'read_file', path: 'secret.txt' },
  ] });
  assert.equal(results[0].ok, true);
  assert.equal(results[0].package.version, '1.2.3');
  assert.equal(results[1].ok, false);
  assert.match(results[1].error, /Symbolic links/);
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

test('Agent tools never expose secret files or environment values', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-agent-secret-'));
  await fs.writeFile(path.join(root, '.env'), 'API_KEY=do-not-read');
  await fs.writeFile(path.join(root, '.env.example'), 'API_KEY=');
  await fs.writeFile(path.join(root, 'server.js'), 'console.log("ok")');
  const listed = await runAgentTools({ sourceDir: root, actions: [{ tool: 'list_files' }] });
  assert.deepEqual(listed[0].files.sort(), ['.env.example', 'server.js']);
  const secret = await runAgentTools({ sourceDir: root, actions: [{ tool: 'read_file', path: '.env' }] });
  assert.equal(secret[0].ok, false);
  assert.match(secret[0].error, /Sensitive/);
  await fs.rm(root, { recursive: true, force: true });
});
