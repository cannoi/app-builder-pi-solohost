import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('package.json exists and is valid', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
  assert.ok(pkg.name);
  assert.equal(pkg.type, 'module');
});

test('health handler is present in source', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/server.js'), 'utf8');
  assert.match(src, /\/health/);
});
