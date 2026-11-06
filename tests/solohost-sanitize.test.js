import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeComposeForSoloHost,
  forceLatestImageTag,
  buildMinimalConfigOptions,
  minimalInstallSelection,
} from '../src/release/solohost.js';

test('forceLatestImageTag rewrites digest/tag to latest', () => {
  assert.equal(forceLatestImageTag('ghcr.io/o/a:sha'), 'ghcr.io/o/a:latest');
  assert.equal(forceLatestImageTag('ghcr.io/o/a'), 'ghcr.io/o/a:latest');
});

test('sanitizeComposeForSoloHost strips security_opt and cap_*', () => {
  const dirty = `services:\n  app:\n    image: x:1\n    security_opt:\n      - no-new-privileges:true\n    cap_add:\n      - NET_ADMIN\n    labels:\n      pi.ui.primary: "true"\n    ports:\n      - "127.0.0.1:20001:8080"\n`;
  const clean = sanitizeComposeForSoloHost(dirty, { image: 'ghcr.io/o/a:latest', hostPort: 20001, containerPort: 8080 });
  assert.equal(/security_opt/i.test(clean), false);
  assert.equal(/cap_add/i.test(clean), false);
  assert.match(clean, /ghcr\.io\/o\/a:latest/);
});

test('minimalInstallSelection keeps only admin password-like vars', () => {
  const r = minimalInstallSelection(['PORT', 'DEBUG', 'ADMIN_PASSWORD', 'API_URL'], { keep: [], fixed: [], omit: [] });
  assert.deepEqual(r.keep, ['ADMIN_PASSWORD']);
});

test('buildMinimalConfigOptions emits valid field name', () => {
  const y = buildMinimalConfigOptions({ project: { name: 'A' }, keepVars: ['ADMIN_PASSWORD'] });
  assert.match(y, /name: ADMIN_PASSWORD/);
  assert.match(y, /type: password/);
});
