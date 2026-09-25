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
