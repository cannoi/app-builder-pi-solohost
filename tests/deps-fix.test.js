import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findMissingNodeModules, ensureMissingDependencies } from '../src/projects/deps-fix.js';

test('detects sqlite3 required by server.js but missing from package.json', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-deps-'));
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { express: '^4.0.0' } }));
  await fs.writeFile(path.join(dir, 'server.js'), "const express = require('express');\nconst sqlite3 = require('sqlite3');\n");
  const found = await findMissingNodeModules(dir);
  assert.deepEqual(found.missing, ['sqlite3']);
  const fixed = await ensureMissingDependencies(dir);
  assert.equal(fixed.changed, true);
  assert.deepEqual(fixed.added, ['sqlite3']);
  const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
  assert.ok(pkg.dependencies.sqlite3);
  await fs.rm(dir, { recursive: true, force: true });
});
