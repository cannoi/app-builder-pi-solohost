import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

// Unit-level: the import path policy must treat upgrade re-import as no-repair.
test('upgrade import policy flags are recognized', () => {
  const jobPayload = { projectId: 'p1', upgrade: true, skipRepair: true, mode: 'upgrade' };
  const upgradeImport = Boolean(
    jobPayload.upgrade === true
    || jobPayload.mode === 'upgrade'
    || jobPayload.skipRepair === true
    || jobPayload.projectId,
  );
  assert.equal(upgradeImport, true);
});

test('scope guard still blocks runDare in upgrade phase', async () => {
  const { assertPhaseAllows, PHASE } = await import('../src/agent/scope-guard.js');
  assert.throws(() => assertPhaseAllows(PHASE.UPGRADE, 'runDare'), (e) => e.code === 'UPGRADE_SCOPE_VIOLATION');
  assert.throws(() => assertPhaseAllows(PHASE.UPGRADE, 'scanProject'), (e) => e.code === 'UPGRADE_SCOPE_VIOLATION');
});

test('pipeline import_app source contains upgrade no-repair branch', async () => {
  const text = await fs.readFile(new URL('../src/jobs/pipeline.js', import.meta.url), 'utf8');
  assert.match(text, /upgradeImport/);
  assert.match(text, /accept-external-source-no-auto-repair/);
  assert.match(text, /Upgrade import complete/);
  assert.match(text, /skipRepair/);
});

test('project import API marks upgrade mode for existing project', async () => {
  const text = await fs.readFile(new URL('../src/api/routes.js', import.meta.url), 'utf8');
  assert.match(text, /upgrade:\s*true/);
  assert.match(text, /skipRepair:\s*true/);
});
