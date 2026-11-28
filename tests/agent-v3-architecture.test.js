import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertPhaseAllows, PHASE, isUpgradeOrigin } from '../src/agent/scope-guard.js';
import { emptyMemory } from '../src/agent/working-memory.js';
import { fingerprint, isDuplicateFailure } from '../src/agent/attempt-ledger.js';
import { analyzePackageDrift, synchronizeSoloHostPackage } from '../src/release/package-synchronizer.js';
import { writeSoloHostPackage } from '../src/release/solohost.js';

test('Upgrade scope guard blocks Build-only operations', () => {
  assert.throws(
    () => assertPhaseAllows(PHASE.UPGRADE, 'runDare'),
    (e) => e.code === 'UPGRADE_SCOPE_VIOLATION',
  );
  assert.throws(
    () => assertPhaseAllows(PHASE.UPGRADE, 'scanProject'),
    (e) => e.code === 'UPGRADE_SCOPE_VIOLATION',
  );
  assert.equal(assertPhaseAllows(PHASE.UPGRADE, 'applyPatch'), true);
  assert.equal(assertPhaseAllows(PHASE.BUILD, 'runDare'), true);
  assert.equal(isUpgradeOrigin({ origin: 'upgrade' }), true);
});

test('Working memory shape', () => {
  const m = emptyMemory({ goal: 'add search', phase: 'upgrade', status: 'running' });
  assert.equal(m.goal, 'add search');
  assert.ok(Array.isArray(m.evidence));
  assert.ok(Array.isArray(m.attempts));
  assert.equal(m.phase, 'upgrade');
});

test('Attempt ledger rejects duplicate failure fingerprint', () => {
  const fp = fingerprint({ failure: 'same-error', sourceHash: 'abc' });
  const ledger = {
    attempts: [{ failureFingerprint: fp, result: 'failed' }],
  };
  assert.equal(isDuplicateFailure(ledger, fp), true);
  assert.equal(isDuplicateFailure(ledger, 'other'), false);
});

test('Package drift detects MISSING config_options vars', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-drift-'));
  await fs.writeFile(
    path.join(root, 'docker-compose.yml'),
    `services:\n  app:\n    image: x\n    environment:\n      API_KEY: \${API_KEY}\n      MODEL: \${MODEL}\n      ENABLE_SEARCH: \${ENABLE_SEARCH}\n`,
  );
  await fs.writeFile(
    path.join(root, 'config_options.yml'),
    `title: Demo\noutput_file: .env\nfields:\n  - name: API_KEY\n    label: Key\n    type: password\n`,
  );
  const drift = await analyzePackageDrift(root);
  assert.ok(drift.missingVars.includes('MODEL'));
  assert.ok(drift.missingVars.includes('ENABLE_SEARCH'));
  assert.equal(drift.needsSync, true);
  await fs.rm(root, { recursive: true, force: true });
});

test('Package synchronizer adds missing vars to config_options', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-sync-'));
  await fs.writeFile(path.join(root, 'server.js'), 'process.env.MODEL; process.env.ENABLE_SEARCH; process.env.API_KEY;');
  await fs.writeFile(
    path.join(root, 'docker-compose.yml'),
    `services:\n  app:\n    image: ghcr.io/x/y:1\n    environment:\n      API_KEY: \${API_KEY}\n      MODEL: \${MODEL}\n      ENABLE_SEARCH: \${ENABLE_SEARCH}\n`,
  );
  await fs.writeFile(
    path.join(root, 'config_options.yml'),
    `title: Demo\noutput_file: .env\nfields:\n  - name: API_KEY\n    type: password\n`,
  );
  const result = await synchronizeSoloHostPackage({
    project: { name: 'Demo', idea: 'Demo', slug: 'demo' },
    sourceDir: root,
    image: 'ghcr.io/x/y:2.0.0',
    hostPort: 18090,
  });
  const config = await fs.readFile(path.join(root, 'solohost/config_options.yml'), 'utf8');
  assert.match(config, /name:\s*MODEL/);
  assert.match(config, /name:\s*ENABLE_SEARCH/);
  assert.match(config, /name:\s*API_KEY/);
  assert.ok(result.synchronization?.envVars || result.message);
  await fs.rm(root, { recursive: true, force: true });
});

test('SoloHost package does not use build: in published compose', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-nobuild-'));
  await fs.writeFile(path.join(root, 'server.js'), 'process.env.PORT');
  await writeSoloHostPackage({
    project: { name: 'X', idea: 'X', slug: 'x' },
    sourceDir: root,
    image: 'ghcr.io/o/a:1',
    hostPort: 18100,
  });
  const compose = await fs.readFile(path.join(root, 'solohost/docker-compose.yml'), 'utf8');
  assert.doesNotMatch(compose, /^\s{4}build:/m);
  assert.match(compose, /image:\s*ghcr\.io\/o\/a:1/);
  await fs.rm(root, { recursive: true, force: true });
});
