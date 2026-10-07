import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('catalog lists all expected providers', () => {
  const { createAIService } = require(path.join(root, 'src/lib/ai-module/ai-service.cjs'));
  const adapter = require(path.join(root, 'src/lib/app-adapter.cjs'));
  const ai = createAIService({ dataDir: path.join(root, 'data'), appName: 'Test', adapter });
  const ids = ai.catalog().map((p) => p.id);
  for (const id of ['openai', 'gemini', 'deepseek', 'anthropic', 'openrouter', 'groq', 'mistral', 'xai', 'custom', 'local']) {
    assert.ok(ids.includes(id), 'missing ' + id);
  }
});

test('chat without key returns localReply', async () => {
  const { createAIService } = require(path.join(root, 'src/lib/ai-module/ai-service.cjs'));
  const adapter = require(path.join(root, 'src/lib/app-adapter.cjs'));
  const ai = createAIService({ dataDir: path.join(root, 'data'), appName: 'Test', adapter });
  const out = await ai.chat({ message: 'How do I publish?' });
  assert.notEqual(out.ok, false);
  const text = String(out.reply || out.text || out.message || '');
  assert.match(text, /Publish|GitHub|token|offline|guide|Builder/i);
});

test('shfh-config and feedback config must not expose cannoi_ ingest token', () => {
  const routes = fs.readFileSync(path.join(root, 'src/api/routes.js'), 'utf8');
  const idx = routes.indexOf("/api/shfh-config");
  const block = routes.slice(idx, idx + 600);
  assert.doesNotMatch(block, /ingestToken/);
  const fb = fs.readFileSync(path.join(root, 'src/lib/feedback-module/feedback-service.cjs'), 'utf8');
  // public config handler should not res.json ingestToken
  assert.doesNotMatch(fb, /res\.json\(\{[^}]*ingestToken/);
});

test('public assets and FAB markup exist', () => {
  assert.ok(fs.existsSync(path.join(root, 'public/ai-icon.png')));
  assert.ok(fs.existsSync(path.join(root, 'public/ai-panel.css')));
  assert.ok(fs.existsSync(path.join(root, 'public/ai-panel.js')));
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  assert.match(html, /id="aiFab"/);
  assert.match(html, /id="aiBadge"/);
  assert.match(html, /ai-module\/ai-module\.js/);
  assert.match(html, /feedback-module\/feedback-module\.js/);
  assert.match(html, /ai-panel\.js/);
  assert.doesNotMatch(html, /id="setProvider"/);
  assert.doesNotMatch(html, /id="setApiKey"/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'public', 'ai-panel.js'), 'utf8'), /setApiKey|setProvider|setBaseUrl|setSave|setTest|setModels/);
});

test('mountUniversalModules loads without throw', async () => {
  const { createApp } = await import('../src/http.js');
  const { mountUniversalModules } = await import('../src/universal/mount-universal.js');
  const app = createApp();
  mountUniversalModules(app, {
    cfg: { version: '1.4.71', feedbackHub: { appId: 'app-builder-pi-solohost', ingestToken: 'cannoi_x' } },
    log: { info() {}, warn() {}, error() {} },
  });
  assert.ok(true);
});

test('server.js actually mounts universal modules', () => {
  const src = fs.readFileSync(path.join(root, 'src/server.js'), 'utf8');
  assert.match(src, /mountUniversalModules\(app/);
});
