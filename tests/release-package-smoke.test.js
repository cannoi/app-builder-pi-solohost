import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveFieldPolicy } from '../src/release/field-gate.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const pipeline = fs.readFileSync(path.join(root, '../src/jobs/pipeline.js'), 'utf8');

test('pipeline never references undeclared identifier input', () => {
  assert.doesNotMatch(pipeline, /\binput\b/);
  assert.match(pipeline, /resolveFieldPolicy/);
  assert.match(pipeline, /\bpayload\b/);
});

test('pipeline uses field-gate before and after GHCR', () => {
  assert.match(pipeline, /Choose install fields before publishing to GitHub/);
  assert.match(pipeline, /GHCR image verified\. Creating the SoloHost install kit/);
  assert.match(pipeline, /package_pending/);
});

test('smoke: no policy => needsChoice; with policy => ready', async () => {
  const os = await import('node:os');
  const fsp = await import('node:fs/promises');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'smoke-'));
  await fsp.mkdir(path.join(dir, 'metadata'), { recursive: true });
  const none = await resolveFieldPolicy({ projectDir: dir, payload: {} });
  assert.equal(none.needsChoice, true);
  const withMode = await resolveFieldPolicy({ projectDir: dir, payload: { fieldMode: 'full' } });
  assert.equal(withMode.needsChoice, false);
  const upg = await resolveFieldPolicy({ projectDir: dir, payload: {}, upgradeOrigin: true });
  assert.equal(upg.needsChoice, false);
});
