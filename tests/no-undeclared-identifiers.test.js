import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const srcRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src');

test('pipeline.js source does not contain identifier input', () => {
  const code = fs.readFileSync(path.join(srcRoot, 'jobs/pipeline.js'), 'utf8');
  assert.doesNotMatch(code, /\binput\b/);
});

test('field-gate.js has no identifier input', () => {
  const code = fs.readFileSync(path.join(srcRoot, 'release/field-gate.js'), 'utf8');
  assert.doesNotMatch(code, /\binput\b/);
});

test('critical release modules parse as ESM', async () => {
  const files = [
    'jobs/pipeline.js',
    'release/field-gate.js',
    'release/solohost-fields.js',
    'release/manager.js',
  ];
  for (const rel of files) {
    const code = fs.readFileSync(path.join(srcRoot, rel), 'utf8');
    // node --check equivalent via dynamic import of path is heavy; use acorn if present
    try {
      const acorn = await import('acorn');
      acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true });
    } catch (err) {
      if (err.code === 'ERR_MODULE_NOT_FOUND') continue;
      assert.fail(`${rel}: ${err.message}`);
    }
  }
});
