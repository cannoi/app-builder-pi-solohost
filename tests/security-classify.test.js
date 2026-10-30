import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanProject } from '../src/security/scanner.js';
import { classifyCredentialSnippet } from '../src/security/classify.js';
import { shouldStopNoProgress, noChangeResult } from '../src/jobs/loop-guard.js';
import { createOperationRecord, finishOperation, TERMINAL, formatUserReport } from '../src/jobs/operation.js';

async function withDir(files, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-sec-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
  try { await fn(dir); } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('Hub ID / Ingest Token / Public URL do not block operation', async () => {
  await withDir({
    'server.js': `
const HUB_ID = "FH-CANNOI-0905428801SH";
const INGEST_TOKEN = "cannoi_client_token_example";
const PUBLIC_BASE_URL = "http://14.176.78.46:8090";
`,
  }, async (dir) => {
    const scan = await scanProject(dir);
    assert.notEqual(scan.status, 'BLOCK');
    assert.equal(scan.critical, 0);
    assert.equal(scan.operationImpact, 'CONTINUE');
  });
});

test('Real Google API key still blocks public release', async () => {
  await withDir({
    'src/app.js': 'const key = "AIzaSyABCDEFGHIJKLMNOPQRSTUVWX123456";\n',
  }, async (dir) => {
    const scan = await scanProject(dir);
    assert.equal(scan.status, 'BLOCK');
    assert.ok(scan.critical >= 1);
  });
});

test('classifyCredentialSnippet labels user config', () => {
  const c = classifyCredentialSnippet({ text: 'SHFH_INGEST_TOKEN=abc', file: 'config.js' });
  assert.equal(c.class, 'USER_DEFINED_CONFIGURATION');
  assert.equal(c.operationImpact, 'CONTINUE');
});

test('no-progress loop stops after repeated same fingerprint', () => {
  assert.equal(shouldStopNoProgress({
    fingerprint: 'NODE_MODULE_MISSING:sqlite3',
    previousFingerprint: 'NODE_MODULE_MISSING:sqlite3',
    attempt: 2,
    validationImproved: false,
    sourceChanged: false,
  }), true);
  assert.equal(shouldStopNoProgress({
    fingerprint: 'HTTP_404',
    previousFingerprint: 'NODE_MODULE_MISSING:sqlite3',
    attempt: 1,
    validationImproved: false,
    sourceChanged: true,
  }), false);
  assert.equal(noChangeResult().terminalState, 'NO_CHANGE');
});

test('operation report format', () => {
  let op = createOperationRecord({ projectId: 'p1', operationType: 'repair', request: 'fix crash' });
  op = finishOperation(op, TERMINAL.DONE, { changedFiles: ['server.js'] });
  const report = formatUserReport(op, { problem: 'crash', changed: ['server.js'], effect: 'starts', verify: { build: 'PASS', run: 'PASS' } });
  assert.match(report, /RESULT: DONE/);
  assert.match(report, /CHANGED: server\.js/);
});
