import test from 'node:test';
import assert from 'node:assert/strict';
import { mapPatchResult, OUTCOMES, formatOutcomeMessage } from '../src/jobs/outcomes.js';
import { assertShape, SchemaMismatch, SHAPES } from '../src/ai/schema.js';
import { classifyFailure, FAILURE_CLASS } from '../src/testing/classify-failure.js';
import { filterPatchFiles } from '../src/jobs/path-safety.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

test('mapPatchResult: rollback is not done', () => {
  const m = mapPatchResult({ filesChanged: 2, rolledBack: true });
  assert.equal(m.outcome, OUTCOMES.ROLLED_BACK);
});

test('mapPatchResult: empty files is no_change', () => {
  const m = mapPatchResult({ filesChanged: 0 });
  assert.equal(m.outcome, OUTCOMES.NO_CHANGE);
  assert.match(formatOutcomeMessage({ outcome: m.outcome, reason: m.reasonEn }), /No code change/);
});

test('schema rejects missing files', () => {
  assert.throws(() => assertShape({ ok: true }, SHAPES.patch), SchemaMismatch);
  assert.doesNotThrow(() => assertShape({ files: [{ path: 'a.js', content: '1' }] }, SHAPES.patch));
});

test('classifyFailure: network is not AI-repair', () => {
  const c = classifyFailure('npm ERR! network ENOTFOUND registry.npmjs.org');
  assert.equal(c.class, FAILURE_CLASS.ENV_NETWORK);
  assert.equal(c.aiRepair, false);
});

test('path safety rejects escape, protected paths and look-alikes of existing files; allows bounded new files', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-'));
  await fs.writeFile(path.join(dir, 'server.js'), 'ok');
  const r = await filterPatchFiles({
    sourceDir: dir,
    files: [
      { path: 'server.js', content: 'x' },
      { path: '../evil.js', content: 'x' },
      { path: '.env', content: 'x' },
      { path: 'src/server.js', content: 'x' }, // hallucinated look-alike of server.js
      { path: 'lan.js', content: 'x' },       // genuinely new file
    ],
    allowedNew: [],
  });
  assert.deepEqual(r.files.map((f) => f.path).sort(), ['lan.js', 'server.js']);
  assert.ok(r.rejected.includes('../evil.js'));
  assert.ok(r.rejected.includes('.env'));
  assert.ok(r.rejected.includes('src/server.js'));
  assert.equal(r.didYouMean['src/server.js'], 'server.js');
  assert.deepEqual(r.created, ['lan.js']);
  assert.equal(r.ok, false);
  assert.match(r.suggestion, /did you mean "server\.js"/);
});
