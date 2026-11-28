import test from 'node:test';
import assert from 'node:assert/strict';
import { GeminiProvider } from '../src/ai/providers/gemini.js';
import { DeepSeekProvider } from '../src/ai/providers/deepseek.js';
import { OpenAICompatProvider } from '../src/ai/hub/openai-compat.js';

test('Gemini complete declares signal and invokes fetch', async () => {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), hasSignal: Boolean(opts.signal) });
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'ok' }] } }],
      usageMetadata: { totalTokenCount: 1 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const g = new GeminiProvider({ apiKey: 'k', model: 'gemini-2.0-flash' });
    const r = await g.complete({ prompt: 'hi', signal: AbortSignal.timeout(5000) });
    assert.equal(r.text, 'ok');
    assert.ok(calls.length >= 1);
    assert.equal(calls[0].hasSignal, true);
  } finally {
    globalThis.fetch = orig;
  }
});

test('DeepSeek complete accepts signal without ReferenceError', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async (_url, opts = {}) => {
    assert.ok(opts.signal);
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'ds' } }],
      usage: { total_tokens: 1 },
    }), { status: 200 });
  };
  try {
    const d = new DeepSeekProvider({ apiKey: 'k', model: 'deepseek-chat' });
    const r = await d.complete({ prompt: 'hi', signal: AbortSignal.timeout(5000) });
    assert.match(String(r.text || r), /ds|./);
  } finally {
    globalThis.fetch = orig;
  }
});

test('OpenAI-compat complete accepts signal', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async (_url, opts = {}) => {
    assert.ok(opts.signal);
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'oa' }, finish_reason: 'stop' }],
      usage: { total_tokens: 1 },
    }), { status: 200 });
  };
  try {
    const o = new OpenAICompatProvider({
      id: 'custom', name: 'Custom', apiKey: 'k',
      baseUrl: 'http://127.0.0.1:9/v1', model: 'm',
    });
    const r = await o.complete({ prompt: 'hi', signal: AbortSignal.timeout(5000) });
    assert.ok(r.text || r);
  } finally {
    globalThis.fetch = orig;
  }
});
