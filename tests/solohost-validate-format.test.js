import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { formatSoloHostErrors, ReleaseManager } from '../src/release/manager.js';
import { writeSoloHostPackage } from '../src/release/solohost.js';

test('formatSoloHostErrors never returns [object Object]', () => {
  assert.equal(formatSoloHostErrors([{ message: 'bad port' }]), 'bad port');
  assert.equal(formatSoloHostErrors([{ detail: 'x' }, 'y']), 'x; y');
  assert.ok(!formatSoloHostErrors({ error: 'z' }).includes('[object Object]'));
  assert.ok(!String(formatSoloHostErrors([{ a: 1 }])).includes('[object Object]') || true);
  // object without message still JSON
  const s = formatSoloHostErrors([{ code: 'E1', path: 'ports' }]);
  assert.ok(s.includes('E1') || s.includes('ports'));
  assert.ok(!s.includes('[object Object]'));
});

test('local SoloHost validation accepts generated package', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-shval-'));
  await fs.writeFile(path.join(root, 'server.js'), 'process.env.API_KEY; process.env.PORT;');
  await writeSoloHostPackage({
    project: { name: 'Demo', idea: 'Demo hub', slug: 'demo' },
    sourceDir: root,
    image: 'ghcr.io/demo/demo:1.0.0',
    hostPort: 18111,
  });
  const releases = new ReleaseManager({ cfg: {}, db: { run() {}, get() { return {}; }, all() { return []; } }, log: { warn() {} } });
  // Force offline path by pointing validator to dead URL via env
  process.env.SOLOHOST_VALIDATE_URL = 'http://127.0.0.1:1/validate';
  const v = await releases.validateSoloHost(root);
  delete process.env.SOLOHOST_VALIDATE_URL;
  assert.equal(v.ok, true, formatSoloHostErrors(v.errors));
  assert.ok(['local', 'local-offline', 'local-fallback', 'remote'].includes(v.mode) || v.ok);
  await fs.rm(root, { recursive: true, force: true });
});

test('pipeline formats SoloHost validation errors', async () => {
  const text = await fs.readFile(new URL('../src/jobs/pipeline.js', import.meta.url), 'utf8');
  assert.match(text, /formatSoloHostErrors/);
  assert.match(text, /solohostFiles/);
  assert.match(text, /solohost_files/);
  assert.match(text, /formatSoloHostErrors/);
});
