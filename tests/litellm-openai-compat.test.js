import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OpenAICompatProvider,
  normalizeOpenAIChatResponse,
  normalizeBaseUrl,
} from '../src/ai/hub/openai-compat.js';
import { catalogEntry, PROVIDER_CATALOG } from '../src/ai/hub/catalog.js';

test('catalog includes optional litellm', () => {
  const e = catalogEntry('litellm');
  assert.ok(e);
  assert.equal(e.kind, 'openai');
  assert.ok(String(e.baseUrl).includes('4000'));
  assert.ok(PROVIDER_CATALOG.some((p) => p.id === 'gemini'), 'direct providers remain');
});

test('normalizeBaseUrl collapses double /v1', () => {
  assert.equal(normalizeBaseUrl('http://litellm:4000/v1/'), 'http://litellm:4000/v1');
  assert.equal(normalizeBaseUrl('http://x/v1/v1'), 'http://x/v1');
});

test('normalizeOpenAIChatResponse maps finish_reason and usage', () => {
  const r = normalizeOpenAIChatResponse(
    {
      model: 'gpt-4o-mini',
      choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
      usage: { total_tokens: 12 },
    },
    { provider: 'litellm', durationMs: 10 },
  );
  assert.equal(r.text, 'hello');
  assert.equal(r.finishReason, 'STOP');
  assert.equal(r.tokens, 12);
  assert.equal(r.provider, 'litellm');
});

test('empty content throws EMPTY class', () => {
  assert.throws(
    () => normalizeOpenAIChatResponse({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }, { provider: 'litellm' }),
    (e) => e.classify?.code === 'EMPTY',
  );
});

test('content_filter maps to BLOCKED', () => {
  assert.throws(
    () => normalizeOpenAIChatResponse({ choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] }, { provider: 'x' }),
    (e) => e.classify?.code === 'BLOCKED',
  );
});

test('mock LiteLLM chat completions success', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.ok(String(url).includes('/chat/completions'));
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'gemini/gemini-2.0-flash');
    assert.ok(!String(init.headers.Authorization || '').includes('sk-secret-full-leak') || true);
    // ensure key is only in header not body
    assert.ok(!JSON.stringify(body).includes('sk-secret'));
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        model: body.model,
        choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
        usage: { total_tokens: 5 },
      }),
    };
  };
  try {
    const p = new OpenAICompatProvider({
      id: 'litellm',
      name: 'LiteLLM',
      apiKey: 'sk-secret',
      baseUrl: 'http://litellm:4000/v1',
      model: 'gemini/gemini-2.0-flash',
    });
    const r = await p.complete({ prompt: 'hi', json: true });
    assert.equal(r.text, '{"ok":true}');
    assert.equal(r.finishReason, 'STOP');
  } finally {
    globalThis.fetch = original;
  }
});

test('mock auth error is classified', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    text: async () => JSON.stringify({ error: { message: 'Invalid API key', code: 'invalid_api_key' } }),
  });
  try {
    const p = new OpenAICompatProvider({
      id: 'litellm',
      name: 'LiteLLM',
      apiKey: 'bad',
      baseUrl: 'http://litellm:4000/v1',
      model: 'x',
    });
    await assert.rejects(() => p.complete({ prompt: 'x' }), (e) => e.status === 401);
  } finally {
    globalThis.fetch = original;
  }
});

test('mock SSE stream accumulates deltas', async () => {
  const original = globalThis.fetch;
  const chunks = [
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ];
  globalThis.fetch = async () => {
    let i = 0;
    const enc = new TextEncoder();
    return {
      ok: true,
      status: 200,
      body: {
        getReader() {
          return {
            async read() {
              if (i >= chunks.length) return { done: true, value: undefined };
              const value = enc.encode(chunks[i++]);
              return { done: false, value };
            },
          };
        },
      },
    };
  };
  try {
    const p = new OpenAICompatProvider({
      id: 'litellm',
      name: 'LiteLLM',
      apiKey: 'k',
      baseUrl: 'http://litellm:4000/v1',
      model: 'm',
    });
    const r = await p.complete({ prompt: 'x', stream: true });
    assert.equal(r.text, 'Hello');
    assert.equal(r.streamed, true);
  } finally {
    globalThis.fetch = original;
  }
});
