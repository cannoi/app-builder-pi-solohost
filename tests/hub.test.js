import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

test('Feedback Hub integration is server-proxied: the ingest token never reaches the browser or the config forms', () => {
  // The Hub key ships as a server-side default so ordinary users never have to enter it (product decision).
  // It must NEVER be present in anything served to the browser, nor requested from the user in the SoloHost forms.
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out); else if (/\.(js|html|css|json|txt|md)$/i.test(e.name)) out.push(p);
    }
    return out;
  };
  const publicDir = fileURLToPath(new URL('../public', import.meta.url));
  for (const f of walk(publicDir)) {
    const text = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(text, /cannoi_[A-Za-z0-9]{12,}/, `${f} must not contain an ingest token`);
    assert.doesNotMatch(text, /SHFH_INGEST_TOKEN\s*[:=]\s*['"][^'"]{8,}/, `${f} must not embed SHFH_INGEST_TOKEN`);
  }
  const cfg = fs.readFileSync(new URL('../config_options.yml', import.meta.url), 'utf8');
  const compose = fs.readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(cfg + compose, /SHFH_INGEST_TOKEN|INGEST_TOKEN/);
});

test('Feedback send uses the server-proxied Hub endpoint and official form fallback', () => {
  const client = fs.readFileSync(new URL('../public/feedback-module/feedback-module.js', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const routes = fs.readFileSync(new URL('../src/api/routes.js', import.meta.url), 'utf8');
  assert.match(client, /json\('\/api\/feedback'/);
  assert.match(routes, /\/api\/feedback/);
  assert.match(html, /data-tab="feedback"/);
});

test('Feedback Hub client keeps credentials out of the browser', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const js = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const client = fs.readFileSync(new URL('../public/feedback-module/feedback-module.js', import.meta.url), 'utf8');
  const routes = fs.readFileSync(new URL('../src/api/routes.js', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /id="feedbackHubUrl"/);
  assert.doesNotMatch(html, /id="feedbackAppId"/);
  assert.doesNotMatch(js, /api\/feedback\/submit/);
  assert.doesNotMatch(client, /ingestToken/);
  assert.doesNotMatch(client, /cannoi_[A-Za-z0-9]{20,}/);
  assert.match(routes, /\/api\/feedback/);
  assert.doesNotMatch(html, /name="password"|id="feedbackPassword"/i);
});
