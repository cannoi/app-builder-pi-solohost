import test from 'node:test';
import assert from 'node:assert/strict';
import { AIGateway } from '../src/ai/gateway.js';

test('invalid JSON from primary AI recovers through the other configured provider', async () => {
  const db = {
    setting() { return ''; },
    setSetting() {},
    run() {},
  };
  const log = { warn() {} };
  const cfg = { ai: { provider: 'deepseek', mode: 'single', deepseekKey: 'x', geminiKey: 'y', deepseekModel: 'deepseek-chat', geminiModel: 'gemini-2.5-flash' } };
  const ai = new AIGateway({ cfg, db, log });
  ai.complete = async () => ({ provider: 'deepseek', model: 'deepseek-chat', text: '{bad', durationMs: 1, tokens: 1 });
  ai.gemini.complete = async () => ({ provider: 'gemini', model: 'gemini-2.5-flash', text: '{"ok":true}', durationMs: 1, tokens: 1 });
  const result = await ai.completeJson({ task: 'DEBUGGING', prompt: 'test', system: 'Return JSON', projectId: 'p' });
  assert.equal(result.json.ok, true);
  assert.equal(result.fallbackFrom, 'deepseek');
});
