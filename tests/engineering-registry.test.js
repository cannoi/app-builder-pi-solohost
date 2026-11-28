import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRegistry, validateDescriptor } from '../src/engineering/registry/registry.js';
import { validateSchema } from '../src/engineering/registry/schema.js';
import { registerReadTools } from '../src/engineering/registry/descriptors/read-tools.js';
import { createEngineeringToolkit } from '../src/engineering/index.js';
import { validateCommand, sanitizeEnv } from '../src/engineering/executor/policy.js';
import { STATUS, mergeStatuses, mapLegacyResult } from '../src/engineering/validation/status.js';
import { buildFingerprint } from '../src/engineering/intel/fingerprint.js';

test('schema validator rejects missing required', () => {
  const r = validateSchema({
    type: 'object',
    required: ['query'],
    properties: { query: { type: 'string' } },
    additionalProperties: false,
  }, {});
  assert.equal(r.ok, false);
});

test('registry rejects duplicate ids and invalid descriptors', () => {
  const reg = createRegistry();
  const base = {
    id: 'fs.demo',
    name: 'Demo',
    description: 'x',
    category: 'project_intel',
    permission: 'READ',
    mode: 'in_process',
    input: { type: 'object', properties: {} },
    handler: async () => ({ ok: true, status: 'PASS', data: {} }),
  };
  reg.register(base);
  assert.throws(() => reg.register(base));
  assert.throws(() => reg.register({ ...base, id: 'Bad Id' }));
});

test('READ tools work against a temp project', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eng-'));
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({
    name: 't', version: '1.0.0', type: 'module', scripts: { start: 'node server.js' },
  }));
  await fs.writeFile(path.join(dir, 'server.js'), 'export default 1;\nconst PORT=8080;\n');
  const toolkit = createEngineeringToolkit({ cfg: { engineering: { mode: 'shadow' } } });
  assert.equal(toolkit.mode, 'shadow');
  assert.ok(toolkit.registry.size() >= 5);

  const listed = await toolkit.registry.call('fs.list', {}, { sourceDir: dir });
  assert.equal(listed.ok, true);
  assert.equal(listed.status, 'PASS');

  const search = await toolkit.registry.call('fs.search_text', { query: 'PORT' }, { sourceDir: dir });
  assert.equal(search.ok, true);

  const fp = await toolkit.fingerprint(dir);
  assert.equal(fp.ok, true);
  assert.ok(fp.data.entrypoint === 'server.js' || fp.data.framework);
});

test('executor policy allowlist', () => {
  assert.equal(validateCommand(['npm', 'test'], { cwd: '/tmp/p', projectRoot: '/tmp/p' }).ok, true);
  assert.equal(validateCommand(['curl', 'http://x'], {}).ok, false);
  assert.equal(validateCommand(['npm', 'install'], { cwd: '/etc', projectRoot: '/tmp/p' }).ok, false);
  const env = sanitizeEnv({ GEMINI_API_KEY: 'secret', PATH: '/usr/bin', FOO: '1' });
  assert.equal(env.GEMINI_API_KEY, undefined);
  assert.equal(env.FOO, '1');
});

test('status vocabulary merge', () => {
  assert.equal(mapLegacyResult('passed'), STATUS.PASS);
  assert.equal(mapLegacyResult('skipped'), STATUS.NOT_TESTED);
  assert.equal(mergeStatuses([STATUS.PASS, STATUS.WARNING]), STATUS.WARNING);
  assert.equal(mergeStatuses([STATUS.PASS, STATUS.FAIL]), STATUS.FAIL);
  assert.equal(mergeStatuses([STATUS.NOT_AVAILABLE, STATUS.NOT_AVAILABLE]), STATUS.NOT_AVAILABLE);
});

test('fingerprint on missing dir is NOT_AVAILABLE', async () => {
  const r = await buildFingerprint(null);
  assert.equal(r.status, STATUS.NOT_AVAILABLE);
});
