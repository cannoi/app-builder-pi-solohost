import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fingerprintError, classifyLayer, isBuiltinModule } from '../src/dare/fingerprint.js';
import { runDare } from '../src/dare/engine.js';

test('fingerprints cannot-find-module variants as NODE_MODULE_MISSING', () => {
  assert.equal(fingerprintError("Cannot find module 'sqlite3'"), 'NODE_MODULE_MISSING:sqlite3');
  assert.equal(fingerprintError("Error: Cannot find module \"sqlite3\"\nRequire stack:"), 'NODE_MODULE_MISSING:sqlite3');
  assert.equal(fingerprintError("node:internal/modules/cjs/loader:1143\nError: Cannot find module 'sqlite3'"), 'NODE_MODULE_MISSING:sqlite3');
  assert.equal(classifyLayer('NODE_MODULE_MISSING:sqlite3'), 'DEPENDENCY_ERROR');
});


test('fingerprints scoped packages and recognizes Node built-ins correctly', () => {
  assert.equal(fingerprintError("Error: Cannot find module '@scope/pkg/subpath'"), 'NODE_MODULE_MISSING:@scope/pkg');
  assert.equal(fingerprintError("Error: Cannot find module 'node:fs'"), 'UNKNOWN');
  assert.equal(isBuiltinModule('node:fs'), true);
  assert.equal(isBuiltinModule('node:test'), true);
});

test('DARE detects missing dependencies in TypeScript and dynamic imports', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-dare-ts-'));
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: {} }));
  await fs.writeFile(path.join(dir, 'server.ts'), "const db = require('better-sqlite3');\nconst x = await import('express');\n");
  const r = await runDare({ sourceDir: dir, logs: "Cannot find module 'better-sqlite3'" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.added, ['better-sqlite3']);
  assert.deepEqual(r.changed, ['package.json']);
  await fs.rm(dir, { recursive: true, force: true });
});

test('DARE upgrades an older Docker Node base only when the engine error proves it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-dare-node-'));
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', engines: { node: '>=22' } }));
  await fs.writeFile(path.join(dir, 'Dockerfile'), 'FROM node:20-alpine\n');
  const r = await runDare({ sourceDir: dir, logs: 'npm ERR! engine Unsupported engine: package requires node >=22' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.files, ['Dockerfile']);
  assert.match(await fs.readFile(path.join(dir, 'Dockerfile'), 'utf8'), /^FROM node:22-alpine/m);
  await fs.rm(dir, { recursive: true, force: true });
});

test('DARE only creates the proven SQLite data directory', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-dare-sqlite-'));
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { sqlite3: '*' } }));
  await fs.writeFile(path.join(dir, 'server.js'), "const sqlite3 = require('sqlite3');\nnew sqlite3.Database('./data/app.db');\n");
  const r = await runDare({ sourceDir: dir, logs: "SQLITE_CANTOPEN: unable to open database file './data/app.db'" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.files, ['data/']);
  assert.equal(r.changed.includes('uploads/'), false);
  await fs.rm(dir, { recursive: true, force: true });
});

test('unknown app logic is not auto-patched', () => {
  assert.equal(fingerprintError('TypeError: Cannot read properties of undefined (reading foo)'), 'APP_LOGIC_UNKNOWN');
});

test('DARE adds missing sqlite3 without AI', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-dare-'));
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { express: '^4.0.0' } }, null, 2));
  await fs.writeFile(path.join(dir, 'server.js'), "const express = require('express');\nconst sqlite3 = require('sqlite3');\n");
  const r = await runDare({ sourceDir: dir, logs: "Cannot find module 'sqlite3'" });
  assert.equal(r.ok, true);
  assert.equal(r.aiRequired, false);
  assert.ok(r.added.includes('sqlite3'));
  const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
  assert.ok(pkg.dependencies.sqlite3);
  await fs.rm(dir, { recursive: true, force: true });
});

test('DARE adds a unique start script', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-dare-start-'));
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: {} }, null, 2));
  await fs.writeFile(path.join(dir, 'server.js'), 'console.log(1)\n');
  const r = await runDare({ sourceDir: dir, logs: 'npm ERR! missing script: start' });
  assert.equal(r.ok, true);
  const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.start, 'node server.js');
  await fs.rm(dir, { recursive: true, force: true });
});

test('DARE patches localhost bind to 0.0.0.0', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-dare-bind-'));
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { express: '4' }, scripts: { start: 'node server.js' } }));
  await fs.writeFile(path.join(dir, 'server.js'), "app.listen(8080, '127.0.0.1');\n");
  const r = await runDare({ sourceDir: dir, logs: "listen(8080, '127.0.0.1')" });
  assert.equal(r.ok, true);
  const src = await fs.readFile(path.join(dir, 'server.js'), 'utf8');
  assert.match(src, /0\.0\.0\.0/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('DARE loop protection stops the second identical repair', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-dare-loop-'));
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { sqlite3: '*' } }));
  await fs.writeFile(path.join(dir, 'server.js'), "require('sqlite3');\n");
  const first = await runDare({ sourceDir: dir, logs: "Cannot find module 'sqlite3'" });
  const second = await runDare({ sourceDir: dir, logs: "Cannot find module 'sqlite3'", history: first.history });
  assert.equal(second.stopped || second.ok === false, true);
  await fs.rm(dir, { recursive: true, force: true });
});

test('DARE accepts a null extra payload from classifyLogs', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-dare-null-extra-'));
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
  const r = await runDare({ sourceDir: dir, logs: 'GitHub Actions finished with failure', extra: null });
  assert.equal(typeof r.ok, 'boolean');
  await fs.rm(dir, { recursive: true, force: true });
});

test('DARE does not invent a start script when two entry files exist', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-dare-2entry-'));
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
  await fs.writeFile(path.join(dir, 'server.js'), '1');
  await fs.writeFile(path.join(dir, 'index.js'), '2');
  const r = await runDare({ sourceDir: dir, logs: 'missing script: start' });
  assert.equal(r.ok, false);
  await fs.rm(dir, { recursive: true, force: true });
});
