import test from 'node:test';
import assert from 'node:assert/strict';
import { GEMINI_MODEL_CANDIDATES, GeminiProvider } from '../src/ai/providers/gemini.js';

test('Gemini candidates prioritize capable models at or above 2.5', () => {
  assert.equal(GEMINI_MODEL_CANDIDATES[0], 'gemini-3.1-pro-preview');
  assert.ok(GEMINI_MODEL_CANDIDATES.some((m) => m === 'gemini-2.5-pro'));
});

test('Gemini discover falls back to any generateContent model', async () => {
  const store = new Map();
  const db = { setting(k, fallback='') { return store.has(k) ? store.get(k) : fallback; }, setSetting(k,v){ store.set(k,v); } };
  const provider = new GeminiProvider({ apiKey:'test', db });
  provider.listModels = async () => [{ name:'models/gemini-2.0-flash', supportedGenerationMethods:['generateContent'] }];
  const found = await provider.discover({ force: true });
  assert.equal(found.model, 'gemini-2.0-flash');
});

test('Gemini sticky model avoids rediscovery', async () => {
  const store = new Map();
  const db = { setting(k, fallback='') { return store.has(k) ? store.get(k) : fallback; }, setSetting(k,v){ store.set(k,v); } };
  const provider = new GeminiProvider({ apiKey:'test', db });
  provider.listModels = async () => [{ name:'models/gemini-2.5-flash-lite', supportedGenerationMethods:['generateContent'] }];
  const first = await provider.discover();
  const second = await provider.discover();
  assert.equal(first.model, 'gemini-2.5-flash-lite');
  assert.equal(second.sticky, true);
  assert.equal(second.model, first.model);
});

test('AI coding prompt requires a previewable Docker contract', async () => {
  const { codePrompt } = await import('../src/ai/prompts.js');
  const text = codePrompt({ name: 'Test', idea: 'A small app' }, {});
  assert.match(text, /Dockerfile/);
  assert.match(text, /health\/readiness endpoint/);
  assert.match(text, /Dockerfile/i);
});
