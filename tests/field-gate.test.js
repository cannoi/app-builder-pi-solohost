import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveFieldPolicy } from '../src/release/field-gate.js';
import { saveFieldPolicy } from '../src/release/solohost-fields.js';

async function tmpProject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-'));
  await fs.mkdir(path.join(dir, 'metadata'), { recursive: true });
  return dir;
}

test('saved policy wins', async () => {
  const dir = await tmpProject();
  await saveFieldPolicy(path.join(dir, 'metadata'), { mode: 'auth', fields: { A: 'keep' }, fixedValues: {} });
  const r = await resolveFieldPolicy({ projectDir: dir, payload: {} });
  assert.equal(r.needsChoice, false);
  assert.equal(r.policy.mode, 'auth');
});

test('payload.fieldPolicy is honored', async () => {
  const dir = await tmpProject();
  const r = await resolveFieldPolicy({
    projectDir: dir,
    payload: { fieldPolicy: { mode: 'defaults', fields: {}, fixedValues: {} } },
  });
  assert.equal(r.needsChoice, false);
  assert.equal(r.policy.mode, 'defaults');
});

test('payload.fieldMode is honored', async () => {
  const dir = await tmpProject();
  const r = await resolveFieldPolicy({
    projectDir: dir,
    payload: { fieldMode: 'custom', fields: { X: 'omit' }, fixedValues: {} },
  });
  assert.equal(r.needsChoice, false);
  assert.equal(r.policy.mode, 'custom');
  assert.equal(r.policy.fields.X, 'omit');
});

test('acceptUnverified and hostPort forwarded; missing keys never throw', async () => {
  const dir = await tmpProject();
  const r = await resolveFieldPolicy({ projectDir: dir, payload: undefined });
  assert.equal(r.acceptUnverified, false);
  assert.equal(r.hostPort, null);
  const r2 = await resolveFieldPolicy({
    projectDir: dir,
    payload: { acceptUnverified: true, hostPort: 18111 },
  });
  assert.equal(r2.acceptUnverified, true);
  assert.equal(r2.hostPort, 18111);
});

test('upgradeOrigin defaults to full without choice', async () => {
  const dir = await tmpProject();
  const r = await resolveFieldPolicy({ projectDir: dir, payload: {}, upgradeOrigin: true });
  assert.equal(r.needsChoice, false);
  assert.equal(r.policy.mode, 'full');
});

test('existingPackage defaults to full without choice', async () => {
  const dir = await tmpProject();
  const r = await resolveFieldPolicy({ projectDir: dir, payload: {}, existingPackage: true });
  assert.equal(r.needsChoice, false);
  assert.equal(r.policy.mode, 'full');
});

test('new project with no policy needs choice', async () => {
  const dir = await tmpProject();
  const r = await resolveFieldPolicy({ projectDir: dir, payload: {} });
  assert.equal(r.needsChoice, true);
  assert.equal(r.policy, null);
});
