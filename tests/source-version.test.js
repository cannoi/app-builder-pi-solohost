import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sourceFingerprint, verificationMatchesSource } from '../src/projects/source-version.js';

test('source fingerprint follows the complete latest project files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-source-version-'));
  const file = path.join(root, 'src', 'app.js');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, 'export const value = 1;\n');
  const first = await sourceFingerprint(root);
  await fs.writeFile(file, 'export const value = 2;\n');
  const second = await sourceFingerprint(root);
  await fs.writeFile(path.join(root, 'config.yml'), 'enabled: true\n');
  const third = await sourceFingerprint(root);
  assert.notEqual(first, second);
  assert.notEqual(second, third);
  await fs.rm(root, { recursive: true, force: true });
});

test('release evidence is fresh only when tests and preview match current source', () => {
  const hash = 'current-source';
  const tests = { sourceHash: hash, previewSourceHash: hash };
  const runtime = { sourceHash: hash };
  assert.equal(verificationMatchesSource(tests, runtime, hash), true);
  assert.equal(verificationMatchesSource({ ...tests, sourceHash: 'old-source' }, runtime, hash), false);
  assert.equal(verificationMatchesSource(tests, { sourceHash: 'old-source' }, hash), false);
});
