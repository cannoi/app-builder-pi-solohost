import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { diagnoseProject } from '../src/diagnose/project.js';

test('project diagnoser detects EACCES and records a deterministic diagnosis without patching files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-diagnose-'));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { express: '^5' } }));
  await fs.writeFile(path.join(root, 'Dockerfile'), 'FROM node:22\nWORKDIR /app\nUSER node\nCOPY . .\nCMD ["node","server.js"]\n');
  await fs.writeFile(path.join(root, 'server.js'), "const fs=require('node:fs'); fs.mkdirSync('/app/data',{recursive:true});");
  const project = { id: 'p1', slug: 'demo', status: 'FAILED' };
  const projects = {
    sourceDir: () => root,
    readMetadata: async (_p, name, fallback) => name === 'upgrade-repair-history.json' ? [{ fingerprint: 'RUNTIME_FILESYSTEM_PERMISSION:/app/data', result: 'failed' }] : fallback,
    saveMetadata: async () => {},
  };
  const report = await diagnoseProject({ project, projects, logs: "Error: EACCES: permission denied, mkdir '/app/data'" });
  assert.equal(report.fingerprint, 'RUNTIME_FILESYSTEM_PERMISSION:/app/data');
  assert.equal(report.confidence, 'high');
  assert.ok(report.problems.some((p) => p.id === 'RUNTIME_FILESYSTEM_PERMISSION'));
  assert.ok(report.previousFailedAttempts.length > 0);
});

test('declared native package plus node-gyp log invalidates NODE_MODULE_MISSING', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-diagnose-native-'));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { 'better-sqlite3': '11.0.0' } }));
  await fs.writeFile(path.join(root, 'server.js'), "require('better-sqlite3');");
  const project = { id: 'p2', slug: 'vault', status: 'FAILED' };
  const projects = {
    sourceDir: () => root,
    readMetadata: async (_p, name, fallback) => fallback,
    saveMetadata: async () => {},
  };
  const report = await diagnoseProject({
    project,
    projects,
    logs: "Cannot find module 'better-sqlite3'\ngyp ERR! build error\nnode-gyp rebuild",
  });
  assert.equal(report.rootCause, 'NATIVE_DEPENDENCY_BUILD_FAILURE');
  assert.ok(report.invalidatedHypotheses.length > 0);
  await fs.rm(root, { recursive: true, force: true });
});

test('advisor report never claims it will mutate Builder or apps', async () => {
  const { buildAdvisorReport } = await import('../src/diagnose/project.js');
  const projects = { list: () => [], readMetadata: async () => [], saveMetadata: async () => {} };
  const report = await buildAdvisorReport({ projects, scope: '30d' });
  assert.equal(report.mutatesCode, false);
  assert.equal(report.overview.appsAnalyzed, 0);
});
