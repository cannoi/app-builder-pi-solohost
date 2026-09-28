import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runDare } from '../src/dare/engine.js';
import { fingerprintError } from '../src/dare/fingerprint.js';

test('Cannot GET / is fingerprinted as a missing root UI', () => {
  assert.equal(fingerprintError('Cannot GET /'), 'MISSING_ROOT_UI');
});

test('DARE serves public/index.html when Express has no static root', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-root-ui-'));
  await fs.mkdir(path.join(dir, 'public'));
  await fs.writeFile(path.join(dir, 'public', 'index.html'), '<html><body><h1>Vault</h1></body></html>');
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'vault', scripts: { start: 'node server.js' }, dependencies: { express: '4.19.2' } }));
  await fs.writeFile(path.join(dir, 'server.js'), `const express = require('express');\nconst app = express();\napp.get('/health', (_req, res) => res.json({ ok: true }));\napp.listen(8080, '0.0.0.0');\n`);
  const result = await runDare({ sourceDir: dir, logs: 'Cannot GET /', extra: { message: 'preflight' }, history: [] });
  const server = await fs.readFile(path.join(dir, 'server.js'), 'utf8');
  assert.equal(result.ok, true);
  assert.match(server, /express\.static/);
  assert.match(server, /sendFile/);
});
