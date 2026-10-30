import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { evaluateProductDepth, isLocalDefaults, hasConfiguredAi } from '../src/jobs/product-checklist.js';

test('isLocalDefaults', () => {
  assert.equal(isLocalDefaults({ source: 'local-defaults' }), true);
  assert.equal(isLocalDefaults({ source: 'ai' }), false);
});

test('hasConfiguredAi reads status', () => {
  assert.equal(hasConfiguredAi({ status: () => ({ configured: true }) }, {}), true);
  assert.equal(hasConfiguredAi({}, { ai: { geminiKey: 'x' } }), true);
  assert.equal(hasConfiguredAi({}, { ai: {} }), false);
});

test('name-only html fails checklist', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-chk-'));
  await fs.writeFile(path.join(dir, 'package.json'), '{"name":"t"}');
  await fs.writeFile(path.join(dir, 'Dockerfile'), 'FROM node:24\n');
  await fs.mkdir(path.join(dir, 'public'));
  await fs.writeFile(path.join(dir, 'public/index.html'), '<html><body><h1>MyApp</h1></body></html>');
  const r = await evaluateProductDepth(dir, { name: 'MyApp' });
  assert.equal(r.ok, false);
  assert.ok(r.issues.includes('ui_name_shell') || r.issues.includes('no_user_action'));
});

test('interactive mini app passes checklist', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-chk-'));
  await fs.writeFile(path.join(dir, 'package.json'), '{"name":"t"}');
  await fs.writeFile(path.join(dir, 'Dockerfile'), 'FROM node:24\n');
  await fs.writeFile(path.join(dir, 'server.js'), `
    import express from 'express';
    const app = express();
    app.get('/health', (_, res) => res.json({ ok: true }));
    app.get('/api/items', (_, res) => res.json([]));
    app.post('/api/items', (_, res) => res.json({ ok: true }));
    app.listen(process.env.PORT || 8080);
  `);
  await fs.mkdir(path.join(dir, 'public'));
  await fs.writeFile(path.join(dir, 'public/index.html'), `
    <html><body>
      <h1>Task Box</h1>
      <p>Add tasks and mark them done. Data stays on your SoloHost.</p>
      <form id="f"><input name="title" placeholder="New task" /><button type="submit">Add</button></form>
      <ul id="list"></ul>
      <script>fetch('/api/items').then(r=>r.json()).then(console.log)</script>
    </body></html>
  `);
  const r = await evaluateProductDepth(dir, { name: 'Task Box' });
  assert.equal(r.ok, true, r.summary);
});
