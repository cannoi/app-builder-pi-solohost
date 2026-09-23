import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CredentialVault } from '../src/ai/hub/credentials.js';
import { AIProviderHub } from '../src/ai/hub/hub.js';

function memDb() {
  const m = new Map();
  return { setting(k, d = null) { return m.has(k) ? m.get(k) : d; }, setSetting(k, v) { m.set(k, v); } };
}

test('credential vault stores encrypted credential material outside AI hub state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-'));
  const vault = new CredentialVault(dir);
  vault.set('conn-1', 'secret-api-key');
  assert.equal(vault.get('conn-1'), 'secret-api-key');
  const files = fs.readdirSync(dir);
  assert.ok(files.includes('ai-provider-hub.key'));
  const raw = fs.readFileSync(path.join(dir, 'ai-provider-hub.key'), 'utf8');
  assert.ok(raw.length > 20);
  assert.doesNotMatch(raw, /secret-api-key/);
});

test('hub public state never exposes provider credentials', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-'));
  const db = memDb();
  const hub = new AIProviderHub({ cfg: { dataDir: dir, ai: { deepseekKey: '', geminiKey: '' } }, db, log: { warn() {} } });
  hub.upsertConnection({ id: 'x', provider: 'openai', apiKey: 'sk-super-secret', status: 'VERIFIED', models: [{ id: 'gpt-test', verified: true }] });
  const text = JSON.stringify(hub.publicState());
  assert.doesNotMatch(text, /sk-super-secret/);
  assert.match(text, /credentialRef/);
});

test('hub never treats undocumented fallback models as verified', async () => {
  const db = memDb();
  const hub = new AIProviderHub({ cfg: { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-')), ai: { deepseekKey: '', geminiKey: '' } }, db, log: { warn() {} } });
  const conn = { id: 'x', provider: 'openai', apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1', models: [] };
  const original = hub.adapter;
  hub.adapter = () => ({ listModels: async () => { throw Object.assign(new Error('network'), { classify: { code: 'NETWORK_ERROR' } }); } });
  const models = await hub.discover(conn);
  hub.adapter = original;
  assert.equal(models.length, 0);
});

test('hub routes only to verified models and respects the selected model pair', () => {
  const db = memDb();
  const hub = new AIProviderHub({ cfg: { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-')), ai: { deepseekKey: '', geminiKey: '' } }, db, log: { warn() {} } });
  hub.upsertConnection({ id: 'a', provider: 'openai', apiKey: 'a', status: 'VERIFIED', models: [{ id: 'fast', verified: true }, { id: 'bad', verified: false }] });
  hub.upsertConnection({ id: 'b', provider: 'groq', apiKey: 'b', status: 'VERIFIED', models: [{ id: 'reasoning', verified: true }] });
  assert.deepEqual(hub.candidates('LOW').map(x => x.model), ['fast', 'reasoning']);
  hub.setRouting({ preferredProvider: 'groq', preferredModels: ['groq:reasoning'] });
  assert.deepEqual(hub.candidates('LOW').map(x => x.model), ['reasoning']);
  hub.setRouting({ preferredProvider: 'openai', preferredModels: ['openai:fast', 'groq:reasoning'] });
  assert.deepEqual(hub.candidates('LOW').map(x => x.model), ['fast', 'reasoning']);
});

test('hub supports manual model validation when discovery is unavailable', async () => {
  const db = memDb();
  const hub = new AIProviderHub({ cfg: { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-')), ai: { deepseekKey: '', geminiKey: '' } }, db, log: { warn() {} } });
  hub.discover = async () => [];
  hub.probeModel = async (_conn, model) => ({ ok: model === 'custom-model', result: { text: 'OK', provider: 'custom', model, durationMs: 1, tokens: 1 } });
  const result = await hub.testConnection({ provider: 'custom', apiKey: 'custom-secret', baseUrl: 'https://example.invalid/v1', model: 'custom-model' });
  assert.equal(result.verifiedModel, 'custom-model');
  assert.equal(result.models[0].verified, true);
});
