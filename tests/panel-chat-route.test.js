import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('Builder exposes /api/panel/chat using AIGateway', async () => {
  const routes = await fs.readFile(new URL('../src/api/routes.js', import.meta.url), 'utf8');
  assert.match(routes, /\/api\/panel\/chat/);
  assert.match(routes, /ai\.complete/);
  assert.match(routes, /USER_CHAT/);
});

test('UniversalAI client prefers /api/panel/chat with relative URLs', async () => {
  const client = await fs.readFile(new URL('../public/ai-module/ai-module.js', import.meta.url), 'utf8');
  assert.match(client, /\/api\/panel\/chat/);
  assert.match(client, /return ''/);
  assert.match(client, /timeoutMs/);
  assert.match(client, /api\/ai\/chat/);
});

test('Panel knowledge stays short', async () => {
  const adapter = await fs.readFile(new URL('../src/lib/app-adapter.cjs', import.meta.url), 'utf8');
  const m = adapter.match(/knowledge:\s*`([\s\S]*?)`/);
  assert.ok(m);
  assert.ok(m[1].length < 900, `knowledge too long: ${m[1].length}`);
});
