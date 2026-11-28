import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPort, randomHighPort, PORT_MIN, PORT_MAX, stableHostPort } from '../src/release/solohost-port.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('hashPort is stable and in high preferred range', () => {
  const a = hashPort('my-app');
  const b = hashPort('my-app');
  assert.equal(a, b);
  assert.ok(a >= PORT_MIN && a <= PORT_MAX, String(a));
  assert.notEqual(a, 18080);
});

test('different slugs get different ports usually', () => {
  assert.notEqual(hashPort('app-one'), hashPort('app-two'));
});

test('randomHighPort stays in preferred range', () => {
  for (let i = 0; i < 10; i++) {
    const p = randomHighPort();
    assert.ok(p >= PORT_MIN && p <= PORT_MAX);
  }
});

test('stableHostPort respects compose loopback port', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-port-'));
  await fs.writeFile(path.join(dir, 'docker-compose.yml'),
    'services:\n  web:\n    ports:\n      - "127.0.0.1:31881:8080"\n');
  const p = await stableHostPort({ slug: 'x' }, null, dir);
  assert.equal(p, 31881);
});
