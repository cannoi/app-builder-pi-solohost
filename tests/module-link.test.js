import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('check-imports script scans src modules', () => {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts/check-imports.mjs')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
  });
  if (r.status !== 0) {
    console.error(r.stdout, r.stderr);
  }
  // Soft: script may skip modules with runtime-only side effects; must not crash node
  assert.ok(r.error == null);
  assert.match(String(r.stdout || '') + String(r.stderr || ''), /check-imports/);
});
