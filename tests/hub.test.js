import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyProviderError, isTransient } from '../src/ai/hub/errors.js';
import { PROVIDER_CATALOG, taskComplexity } from '../src/ai/hub/catalog.js';
import { AIProviderHub } from '../src/ai/hub/hub.js';

function memDb() {
  const store = new Map();
  return {
    setting(k, fallback) { return store.has(k) ? store.get(k) : fallback; },
    setSetting(k, v) { store.set(k, v); },
  };
}

test('provider error classes are normalized', () => {
  assert.equal(classifyProviderError('HTTP 401 invalid api key').code, 'INVALID_CREDENTIAL');
  assert.equal(classifyProviderError('HTTP 429 rate limit').code, 'RATE_LIMITED');
  assert.equal(classifyProviderError('fetch failed').code, 'NETWORK_ERROR');
  assert.equal(isTransient('RATE_LIMITED'), true);
  assert.equal(isTransient('INVALID_CREDENTIAL'), false);
});

test('catalog includes popular providers and custom adapter', () => {
  const ids = PROVIDER_CATALOG.map((p) => p.id);
  for (const id of ['openai', 'gemini', 'deepseek', 'anthropic', 'openrouter', 'groq', 'mistral', 'xai', 'custom']) {
    assert.ok(ids.includes(id), id);
  }
  assert.equal(taskComplexity('CODING'), 'high');
  assert.equal(taskComplexity('USER_CHAT'), 'low');
});

test('hub migrates existing DeepSeek/Gemini keys', () => {
  const cfg = { ai: { deepseekKey: 'sk-test-deepseek', deepseekModel: 'deepseek-v4-flash', geminiKey: '', geminiModel: '' } };
  const hub = new AIProviderHub({ cfg, db: memDb(), log: { warn() {} } });
  const pub = hub.publicState();
  assert.ok(pub.connections.some((c) => c.provider === 'deepseek'));
  assert.match(pub.connections[0].masked, /\•|sk-|\*/);
  assert.doesNotMatch(JSON.stringify(pub), /sk-test-deepseek/);
});

test('hub routing prefers provider when locked', () => {
  const cfg = { ai: { deepseekKey: 'a', deepseekModel: 'deepseek-v4-flash', geminiKey: 'b', geminiModel: 'gemini-2.5-flash' } };
  const hub = new AIProviderHub({ cfg, db: memDb(), log: { warn() {} } });
  hub.setRouting({ mode: 'PROVIDER', preferredProvider: 'deepseek' });
  const picks = hub.candidates('USER_CHAT');
  assert.ok(picks.every((p) => p.conn.provider === 'deepseek'));
});

test('hub normalizes malformed connection model state instead of calling array methods on non-arrays', () => {
  const db = memDb();
  const hub = new AIProviderHub({ cfg: { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-')), ai: { deepseekKey: '', geminiKey: '' } }, db, log: { warn() {} } });
  db.setSetting('aiHub', { mode: 'SELECTED', preferredProvider: 'gemini', preferredModel: 'gemini-test', preferredModels: ['gemini-test'], connections: [{ id: 'gm', provider: 'gemini', credentialRef: 'gm', models: { id: 'gemini-test', verified: true }, status: 'VERIFIED' }] });
  assert.doesNotThrow(() => hub.publicState());
  assert.doesNotThrow(() => hub.syncLegacyKeys(hub.state()));
  assert.deepEqual(hub.state().connections[0].models, [{ id: 'gemini-test', verified: true }]);
});

test('hub stores a selected model pair without AUTO/PROVIDER/MANUAL modes', () => {
  const db = memDb();
  const hub = new AIProviderHub({ cfg: { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-')), ai: { deepseekKey: '', geminiKey: '' } }, db, log: { warn() {} } });
  hub.setRouting({ preferredProvider: 'gemini', preferredModels: ['gemini-a', 'deepseek-b'] });
  const state = hub.state();
  assert.equal(state.mode, 'SELECTED');
  assert.deepEqual(state.preferredModels, ['gemini-a', 'deepseek-b']);
});
