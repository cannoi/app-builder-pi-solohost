import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanProject } from '../src/security/scanner.js';
import { runStaticTests } from '../src/testing/engine.js';

async function withDir(files, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
  try { await fn(dir); } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('scanner blocks secrets and docker.sock', async () => {
  await withDir({
    'src/app.js': 'const key = "AIzaSyABCDEFGHIJKLMNOPQRSTUVWX123456";\n',
    'docker-compose.yml': 'volumes:\n  - /var/run/docker.sock:/var/run/docker.sock\n',
  }, async (dir) => {
    const scan = await scanProject(dir);
    assert.equal(scan.status, 'BLOCK');
    assert.ok(scan.critical >= 1);
  });
});

test('static tests pass on the bundled template', async () => {
  const dir = path.resolve('templates/hello-ai-app');
  const result = await runStaticTests(dir);
  assert.equal(result.status, 'passed', JSON.stringify(result.checks, null, 2));
});
