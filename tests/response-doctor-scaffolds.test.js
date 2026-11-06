import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonLenient, parseNeedFiles, salvageFileBlocks } from '../src/ai/response-doctor.js';
import { ensureBoilerplate } from '../src/jobs/scaffolds.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

test('doctor repairs trailing comma', () => {
  const r = parseJsonLenient('{"files":[{"path":"a.js","content":"x"},],}');
  assert.equal(r.ok, true);
  assert.equal(r.value.files[0].path, 'a.js');
});

test('doctor salvages FILE blocks', () => {
  const text = '<<<FILE path="server.js">>>\nconsole.log(1)\n<<<END FILE>>>';
  const files = salvageFileBlocks(text);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, 'server.js');
});

test('parse NEED_FILES', () => {
  const n = parseNeedFiles('I need more context [NEED_FILES: server.js, public/app.js:1-50]');
  assert.ok(n.includes('server.js'));
});

test('ensureBoilerplate writes missing Dockerfile once', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-scaf-'));
  const w1 = await ensureBoilerplate(dir);
  assert.ok(w1.includes('Dockerfile'));
  const w2 = await ensureBoilerplate(dir);
  assert.equal(w2.length, 0);
});
