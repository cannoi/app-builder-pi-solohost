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
  let calls = 0;
  ai.hub.execute = async () => { calls += 1; return calls === 1 ? { provider: 'deepseek', model: 'deepseek-chat', text: '{bad', durationMs: 1, tokens: 1 } : { provider: 'gemini', model: 'gemini-2.5-flash', text: '{\"ok\":true}', durationMs: 1, tokens: 1 }; };

  const result = await ai.completeJson({ task: 'DEBUGGING', prompt: 'test', system: 'Return JSON', projectId: 'p' });
  assert.equal(result.json.ok, true);
  assert.equal(result.fallbackFrom, 'deepseek');
  assert.equal(calls, 2);
});

test('gateway combines two selected models as builder and reviewer for code tasks', async () => {
  const cfg = { ai: { provider: 'deepseek', mode: 'single', deepseekKey: 'x', geminiKey: 'y', deepseekModel: 'fast', geminiModel: 'review' } };
  const db = { setting(k, d) { return k === 'aiHub' ? { mode: 'SELECTED', preferredModels: ['deepseek:fast', 'gemini:review'], connections: [] } : d; }, run() {}, setSetting() {} };
  const gateway = new AIGateway({ cfg, db, log: { warn() {} } });
  const calls = [];
  gateway.hub.selectedModels = () => ['deepseek:fast', 'gemini:review'];
  gateway.hub.execute = async ({ modelRef }) => {
    calls.push(modelRef);
    return modelRef === 'deepseek:fast'
      ? { provider: 'deepseek', model: 'fast', text: '{"files":["a.js"],"ok":true}', durationMs: 1, tokens: 1 }
      : { provider: 'gemini', model: 'review', text: '{"accept":true,"score":95,"issues":[],"reason":"safe"}', durationMs: 1, tokens: 1 };
  };
  const result = await gateway.completeJson({ task: 'CODING', prompt: 'Fix the button.' });
  assert.deepEqual(calls, ['deepseek:fast', 'gemini:review']);
  assert.equal(result.json.ok, true);
  assert.equal(result.council.reviewer, 'gemini');
  assert.equal(result.council.review.accept, true);
});
