import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('Settings: single typeable model + Load models, no Upload', async () => {
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="hubModel"/);
  assert.match(html, /id="hubModelOptions"/);
  assert.match(html, /id="hubLoadModels"/);
  assert.match(html, /id="hubAdd"/);
  assert.doesNotMatch(html, /hubUploadModels/);
  assert.doesNotMatch(html, /Upload model list/);
  assert.doesNotMatch(html, /hubModel1/);
  const modelIdx = html.indexOf('id="hubModel"');
  const loadIdx = html.indexOf('id="hubLoadModels"');
  const addIdx = html.indexOf('id="hubAdd"');
  assert.ok(modelIdx > 0 && loadIdx > modelIdx && addIdx > loadIdx);
});

test('Load models calls /api/ai/hub/discover with provider+key', async () => {
  const js = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(js, /\/api\/ai\/hub\/discover/);
  assert.match(js, /hubKey/);
  assert.match(js, /fillModelOptionsFromList/);
  assert.doesNotMatch(js, /hubUploadModels/);
});

test('Discover API uses testConnection', async () => {
  const routes = await fs.readFile(new URL('../src/api/routes.js', import.meta.url), 'utf8');
  assert.match(routes, /\/api\/ai\/hub\/discover/);
  assert.match(routes, /testConnection/);
});
