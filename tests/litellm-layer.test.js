import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAiResult,
  toLiteLLMModelId,
  litellmEnabled,
} from '../src/ai/litellm-layer.js';

test('normalizeAiResult standardizes provider payloads', () => {
  const r = normalizeAiResult({
    provider: 'gemini',
    model: 'gemini-x',
    text: 'hi',
    durationMs: 12,
    tokens: 3,
  });
  assert.equal(r.normalized, true);
  assert.equal(r.via, 'litellm-layer');
  assert.equal(r.text, 'hi');
  assert.equal(r.finishReason, 'STOP');
});

test('toLiteLLMModelId prefixes gemini', () => {
  assert.equal(toLiteLLMModelId('gemini', 'gemini-2.0-flash'), 'gemini/gemini-2.0-flash');
  assert.equal(toLiteLLMModelId('gemini', 'gemini/already'), 'gemini/already');
});

test('litellmEnabled is false without env', () => {
  const prev = process.env.LITELLM_BASE_URL;
  delete process.env.LITELLM_BASE_URL;
  delete process.env.LITELLM_URL;
  assert.equal(litellmEnabled(), false);
  if (prev !== undefined) process.env.LITELLM_BASE_URL = prev;
});
