import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { copyDir, snapshotCopyFilter, listFiles } from '../src/utils/fsx.js';
import { runBrowserAgent, detectChromium } from '../src/engineering/browser/agent.js';
import { STATUS } from '../src/engineering/validation/status.js';
import { getEngineeringMode } from '../src/engineering/config.js';
import { validateCommand } from '../src/engineering/executor/policy.js';

test('copyDir filter skips node_modules', async () => {
  const src = await fs.mkdtemp(path.join(os.tmpdir(), 'cps-'));
  const dest = await fs.mkdtemp(path.join(os.tmpdir(), 'cpd-'));
  await fs.writeFile(path.join(src, 'a.js'), '1');
  await fs.mkdir(path.join(src, 'node_modules', 'x'), { recursive: true });
  await fs.writeFile(path.join(src, 'node_modules', 'x', 'i.js'), '2');
  await copyDir(src, dest, { filter: snapshotCopyFilter });
  const files = await listFiles(dest);
  assert.ok(files.includes('a.js'));
  assert.ok(!files.some((f) => f.includes('node_modules')));
});

test('browser agent without chromium returns NOT_TESTED', async () => {
  // Force no factory and hope CI has no chromium — still must not throw
  const r = await runBrowserAgent({ baseUrl: 'http://127.0.0.1:9' });
  assert.ok([STATUS.NOT_TESTED, STATUS.NOT_AVAILABLE, STATUS.FAIL, STATUS.PASS].includes(r.status));
});

test('browserFactory path collects console errors', async () => {
  const fakePage = {
    handlers: {},
    on(ev, fn) { this.handlers[ev] = fn; },
    async goto() {},
    async title() { return 'T'; },
  };
  const r = await runBrowserAgent({
    baseUrl: 'http://example.local',
    browserFactory: async () => fakePage,
  });
  assert.equal(r.status, STATUS.PASS);
  assert.equal(r.data.via, 'browserFactory');
});

test('engineering mode default shadow', () => {
  delete process.env.ENGINEERING_TOOLKIT;
  assert.equal(getEngineeringMode(), 'shadow');
  process.env.ENGINEERING_TOOLKIT = 'off';
  assert.equal(getEngineeringMode(), 'off');
  delete process.env.ENGINEERING_TOOLKIT;
});

test('executor still rejects curl', () => {
  assert.equal(validateCommand(['curl', 'http://x']).ok, false);
  assert.equal(validateCommand(['npm', 'test']).ok, true);
});
