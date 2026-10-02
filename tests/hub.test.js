import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyProviderError, isTransient } from '../src/ai/hub/errors.js';
import { PROVIDER_CATALOG, taskComplexity } from '../src/ai/hub/catalog.js';
import { AIProviderHub } from '../src/ai/hub/hub.js';
import { forwardHubFeedback } from '../src/feedback/proxy.js';

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

test('Feedback Hub credentials are configured by the owner and never exposed in the Builder UI', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const js = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const routes = fs.readFileSync(new URL('../src/api/routes.js', import.meta.url), 'utf8');
  const config = fs.readFileSync(new URL('../src/config/loader.js', import.meta.url), 'utf8');
  const server = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const compose = fs.readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
  const options = fs.readFileSync(new URL('../config_options.yml', import.meta.url), 'utf8');
  const solohostCompose = fs.readFileSync(new URL('../solohost/docker-compose.yml', import.meta.url), 'utf8');
  const solohostOptions = fs.readFileSync(new URL('../solohost/config_options.yml', import.meta.url), 'utf8');
  const envExample = fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  assert.match(html, /id="feedbackBtn"/);
  assert.doesNotMatch(html, /feedbackHubUrl|feedbackHubId|feedbackIngestToken/);
  assert.match(js, /api\('\/api\/feedback\/submit'/);
  assert.doesNotMatch(js, /SHFH\.create|feedbackHubUrl|feedbackHubId|feedbackIngestToken/);
  assert.match(routes, /r\.post\('\/api\/feedback\/submit'/);
  assert.match(config, /hubUrl: process\.env\.SHFH_HUB_URL/);
  assert.match(config, /hubId: process\.env\.SHFH_HUB_ID/);
  assert.match(config, /ingestToken: process\.env\.SHFH_INGEST_TOKEN/);
  for (const name of ['SHFH_HUB_URL', 'SHFH_HUB_ID', 'SHFH_INGEST_TOKEN']) {
    assert.match(compose, new RegExp(`${name}: "\\$\\{${name}:-\\}"`));
    assert.match(options, new RegExp(`name: ${name}`));
    assert.match(solohostCompose, new RegExp(`${name}: "\\$\\{${name}:-\\}"`));
    assert.match(solohostOptions, new RegExp(`name: ${name}`));
    assert.match(envExample, new RegExp(`^${name}=$`, 'm'));
  }
  assert.match(options, /name: SHFH_INGEST_TOKEN[\s\S]*?type: password/);
  assert.match(server, /retiredFeedbackKeys/);
  assert.match(server, /retiredFeedbackKeys/);
  assert.match(server, /delete saved\[key\]/);
  assert.doesNotMatch(routes + config + js + html + compose + options + solohostCompose + solohostOptions + envExample, /14\.176\.78\.46|FH-CANNOI-0905428801SH|cannoi_[A-Za-z0-9]{20,}/);
  assert.doesNotMatch(js, /cannoi_[A-Za-z0-9]{20,}/);
  assert.ok(routes.indexOf('r.use(accessAuth.middleware)') < routes.indexOf("r.post('/api/feedback/submit'"));
});

test('Feedback proxy keeps Hub credentials server-side and submits only bounded feedback', async () => {
  const calls = [];
  const config = { hubUrl: 'https://hub.example', hubId: 'hub-1', ingestToken: 'ingest-test-token' };
  const result = await forwardHubFeedback({
    config,
    type: 'question',
    message: 'Is this available?',
    locale: 'en',
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return { ok: true };
    },
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls[0].url, 'https://hub.example/api/feedback');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer ingest-test-token');
  assert.equal(calls[0].options.headers['X-SHFH-Hub-ID'], 'hub-1');
  assert.doesNotMatch(calls[0].url, /ingest-test-token|hub-1/);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    schema_version: '2.2',
    app_id: 'app-builder-pi-solohost',
    app_name: 'App Builder — Pi SoloHost',
    version: '1.4.61',
    platform: 'solohost',
    locale: 'en',
    event: 'feedback',
    hub_id: 'hub-1',
    type: 'question',
    rating: 0,
    message: 'Is this available?',
  });
  await assert.rejects(forwardHubFeedback({ config: { ...config, hubUrl: 'http://hub.example' }, type: 'bug', message: 'x' }), /HTTPS/);
  await assert.rejects(forwardHubFeedback({ config: {}, type: 'bug', message: 'x' }), (err) => err.code === 'FEEDBACK_NOT_CONFIGURED');
});

test('Feedback Hub config endpoint returns metadata and submit route never returns credentials', () => {
  const routes = fs.readFileSync(new URL('../src/api/routes.js', import.meta.url), 'utf8');
  const js = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const configRoute = routes.slice(routes.indexOf("r.get('/api/shfh-config'"), routes.indexOf("r.post('/api/feedback/submit'"));
  const submitRoute = routes.slice(routes.indexOf("r.post('/api/feedback/submit'"), routes.indexOf("r.get('/api/ai/hub'"));
  assert.match(configRoute, /configured: Boolean\(hub\.hubUrl && hub\.hubId && hub\.ingestToken\)/);
  assert.match(submitRoute, /forwardHubFeedback\(\{ config: cfg\.feedbackHub/);
  assert.match(js, /api\('\/api\/feedback\/submit'/);
});
