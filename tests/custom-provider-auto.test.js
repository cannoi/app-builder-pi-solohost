import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpenAICompatProvider, normalizeBaseUrl, preferAutoModel } from '../src/ai/hub/openai-compat.js';
import { AIProviderHub } from '../src/ai/hub/hub.js';
import { catalogEntry } from '../src/ai/hub/catalog.js';

function memDb() {
  const m = new Map();
  return { setting(k, d = null) { return m.has(k) ? m.get(k) : d; }, setSetting(k, v) { m.set(k, v); } };
}

test('normalizeBaseUrl strips trailing slash and double /v1', () => {
  assert.equal(normalizeBaseUrl('http://personal-ai-hub:8080/v1/'), 'http://personal-ai-hub:8080/v1');
  assert.equal(normalizeBaseUrl('http://personal-ai-hub:8080/v1/v1'), 'http://personal-ai-hub:8080/v1');
});

test('preferAutoModel picks auto when present', () => {
  assert.equal(preferAutoModel([{ id: 'qwen' }, { id: 'auto' }]), 'auto');
  assert.equal(preferAutoModel([{ id: 'qwen' }]), null);
});

test('CUSTOM_PROVIDER_MODEL_DISCOVERY: listModels reads data[].id from Personal AI Hub shape', async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), method: opts?.method || 'GET', headers: opts?.headers });
    if (String(url).endsWith('/models')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          data: [
            { id: 'auto' },
            { id: 'qwen2.5-coder:1.5b' },
            { id: 'local/qwen2.5-coder:1.5b' },
            { id: 'ollama/qwen2.5-coder:1.5b' },
          ],
        }),
      };
    }
    if (String(url).endsWith('/chat/completions')) {
      const body = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          choices: [{ message: { content: body.model === 'auto' ? 'OK-AUTO' : 'OK' } }],
          usage: { total_tokens: 3 },
        }),
      };
    }
    return { ok: false, status: 404, text: async () => 'not found' };
  };
  try {
    const p = new OpenAICompatProvider({
      id: 'custom',
      name: 'Custom',
      apiKey: 'pah_test_key',
      baseUrl: 'http://personal-ai-hub:8080/v1',
    });
    const models = await p.listModels();
    assert.ok(models.some((m) => m.id === 'auto'));
    assert.ok(calls[0].url === 'http://personal-ai-hub:8080/v1/models');
    assert.match(calls[0].headers.Authorization, /Bearer pah_test_key/);
    assert.equal(calls[0].headers['X-Personal-AI-Key'], 'pah_test_key');

    const result = await p.complete({ prompt: 'hi', system: 'test', model: 'auto' });
    assert.equal(result.text, 'OK-AUTO');
    assert.equal(result.model, 'auto');
    const chatCall = calls.find((c) => c.url.endsWith('/chat/completions'));
    assert.ok(chatCall);
    assert.equal(chatCall.url, 'http://personal-ai-hub:8080/v1/chat/completions');
  } finally {
    globalThis.fetch = original;
  }
});

test('AUTO_MODEL: testConnection prefers auto and does not throw No usable model', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('/models')) {
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ data: [{ id: 'auto' }, { id: 'qwen2.5-coder:1.5b' }] }),
      };
    }
    if (String(url).includes('/chat/completions')) {
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: 'OK' } }] }),
      };
    }
    return { ok: false, status: 500, text: async () => 'err' };
  };
  try {
    const hub = new AIProviderHub({
      cfg: { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'hub-')), ai: { deepseekKey: '', geminiKey: '' } },
      db: memDb(),
      log: { warn() {} },
    });
    const probed = await hub.testConnection({
      provider: 'custom',
      apiKey: 'pah_x',
      baseUrl: 'http://personal-ai-hub:8080/v1',
    });
    assert.equal(probed.ok, true);
    assert.ok(probed.models.some((m) => m.id === 'auto'));
    assert.equal(probed.verifiedModel, 'auto');
  } finally {
    globalThis.fetch = original;
  }
});

test('CUSTOM empty discovery still seeds auto for custom provider', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/models')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: [] }) };
    }
    if (String(url).includes('/chat/completions')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'OK' } }] }) };
    }
    return { ok: false, status: 404, text: async () => '' };
  };
  try {
    const hub = new AIProviderHub({
      cfg: { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'hub-')), ai: { deepseekKey: '', geminiKey: '' } },
      db: memDb(),
      log: { warn() {} },
    });
    const probed = await hub.testConnection({
      provider: 'custom',
      apiKey: 'pah_x',
      baseUrl: 'http://personal-ai-hub:8080/v1',
    });
    assert.equal(probed.ok, true);
    assert.ok(probed.models.some((m) => m.id === 'auto'));
  } finally {
    globalThis.fetch = original;
  }
});

test('catalog custom has discover + auto fallback', () => {
  const c = catalogEntry('custom');
  assert.equal(c.discover, true);
  assert.ok(c.fallbackModels?.includes('auto'));
});

test('complete defaults to model auto when none set', async () => {
  const original = globalThis.fetch;
  let usedModel = '';
  globalThis.fetch = async (_url, opts) => {
    usedModel = JSON.parse(opts.body).model;
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'OK' } }] }) };
  };
  try {
    const p = new OpenAICompatProvider({ id: 'custom', name: 'Custom', apiKey: 'k', baseUrl: 'http://x/v1', model: '' });
    await p.complete({ prompt: 'p', system: 's' });
    assert.equal(usedModel, 'auto');
  } finally {
    globalThis.fetch = original;
  }
});
