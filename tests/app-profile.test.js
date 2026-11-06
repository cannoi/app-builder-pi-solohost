import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { detectAppProfile } from '../src/runtime/app-profile.js';

test('detects vite/tanstack as preferPublish', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-prof-'));
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({
    name: 'ofie',
    scripts: { dev: 'vite dev', build: 'vite build' },
    dependencies: { vite: '5.0.0', '@tanstack/react-router': '1.0.0' },
  }));
  await fs.writeFile(path.join(dir, 'vite.config.ts'), 'export default {}');
  await fs.writeFile(path.join(dir, 'Dockerfile'), 'FROM node AS build\nRUN vite build\nFROM node\nCMD node .output/server/index.mjs\n');
  const p = await detectAppProfile(dir);
  assert.equal(p.preferPublish, true);
  assert.ok(p.signals.includes('vite'));
  assert.match(p.guidance.en, /Publish|SoloHost|framework/i);
});

test('simple node start is preview friendly', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-prof2-'));
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({
    name: 'simple',
    scripts: { start: 'node server.js' },
  }));
  await fs.writeFile(path.join(dir, 'server.js'), 'console.log(1)');
  const p = await detectAppProfile(dir);
  assert.equal(p.previewFriendly, true);
  assert.equal(p.preferPublish, false);
});
