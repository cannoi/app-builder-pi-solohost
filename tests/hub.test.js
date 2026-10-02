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

test('Feedback Hub credentials are requested per session and never baked into the Builder', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const js = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const routes = fs.readFileSync(new URL('../src/api/routes.js', import.meta.url), 'utf8');
  const config = fs.readFileSync(new URL('../src/config/loader.js', import.meta.url), 'utf8');
  const server = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.match(html, /id="feedbackBtn"/);
  assert.match(html, /id="feedbackBadge"/);
  assert.match(html, /id="feedbackHubUrl"/);
  assert.match(html, /id="feedbackHubId"/);
  assert.match(html, /id="feedbackIngestToken" type="password"/);
  assert.match(js, /SHFH\.create/);
  assert.match(js, /Enter the Hub URL, Hub ID, and ingest token for this session/);
  assert.match(js, /feedbackIngestToken'\)\.value\s*=\s*''/);
  assert.doesNotMatch(routes, /r\.post\('\/api\/feedback\/submit'/);
  assert.doesNotMatch(routes + config + js + html, /14\.176\.78\.46|FH-CANNOI-0905428801SH|cannoi_[A-Za-z0-9]{20,}/);
  assert.doesNotMatch(config, /FEEDBACK_HUB_URL|SHFH_HUB_URL|SHFH_HUB_ID|SHFH_INGEST_TOKEN/);
  assert.doesNotMatch(routes, /process\.env\.FEEDBACK_HUB_URL|hub\.url|hub\.hubId|hub\.ingestToken/);
  assert.match(routes, /SHFH_INGEST_TOKEN/);
  assert.match(server, /retiredFeedbackKeys/);
  assert.match(server, /retiredFeedbackKeys/);
  assert.match(server, /delete saved\[key\]/);
  assert.doesNotMatch(js, /cannoi_[A-Za-z0-9]{20,}/);
});

test('Feedback uses the SDK directly and opens only the operator-entered official form as fallback', () => {
  const js = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const sdk = fs.readFileSync(new URL('../modules/feedback/shfh-client.js', import.meta.url), 'utf8');
  const publicSdk = fs.readFileSync(new URL('../public/shfh-client.js', import.meta.url), 'utf8');
  assert.match(js, /state\.feedbackHub\.sendFeedback\(\{ type, message \}\)/);
  assert.match(js, /window\.open\(formUrl, '_blank', 'noopener'\)/);
  assert.match(js, /parsedHub\.protocol !== 'https:'/);
  assert.match(sdk, /headers\.Authorization = "Bearer " \+ ingestToken/);
  assert.match(sdk, /hub_id: hubId/);
  assert.doesNotMatch(sdk, /license:\s*\{/);
  assert.doesNotMatch(sdk, /[?&]key=/);
  assert.equal(publicSdk, sdk);
});

test('Feedback Hub config endpoint returns metadata only and runtime form is reset on each open', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const js = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const routes = fs.readFileSync(new URL('../src/api/routes.js', import.meta.url), 'utf8');
  assert.match(html, /id="feedbackHubUrl"/);
  assert.match(html, /id="feedbackHubId"/);
  assert.match(html, /id="feedbackIngestToken"/);
  assert.match(js, /const FEEDBACK_APP_ID\s*=\s*['"]app-builder-pi-solohost['"]/);
  assert.match(js, /state\.feedbackHub\.sendFeedback\(\{ type, message \}\)/);
  assert.match(routes, /r\.get\('\/api\/shfh-config'/);
  assert.doesNotMatch(routes, /hub\.url|hub\.hubId|hub\.ingestToken/);
  assert.doesNotMatch(routes, /r\.post\('\/api\/feedback\/submit'/);
  assert.match(js, /state\.feedbackHub = null;\s*state\.feedbackSnapshot = null;\s*\$\('feedbackHubUrl'\)\.value = ''/);
  assert.doesNotMatch(js, /cannoi_[A-Za-z0-9]{20,}/);
});
