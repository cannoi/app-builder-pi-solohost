import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  accessPasswordConfigured,
  verifyAccessPassword,
  isAccessAuthorized,
} from '../src/http-access-auth.js';

test('access password disabled when env empty', () => {
  assert.equal(accessPasswordConfigured({ accessPassword: '' }), false);
  assert.equal(verifyAccessPassword('x', { accessPassword: '' }).ok, true);
});

test('access password required when configured', () => {
  const cfg = { accessPassword: 'super-secret-password-16' };
  assert.equal(accessPasswordConfigured(cfg), true);
  assert.equal(verifyAccessPassword('wrong', cfg).ok, false);
  const ok = verifyAccessPassword('super-secret-password-16', cfg);
  assert.equal(ok.ok, true);
  assert.ok(ok.token);
  assert.equal(isAccessAuthorized({ headers: { cookie: `builder_access=${ok.token}` } }, cfg), true);
  assert.equal(isAccessAuthorized({ headers: {} }, cfg), false);
});

test('publish gate requires GitHub token in source', () => {
  const src = fs.readFileSync(new URL('../src/jobs/pipeline.js', import.meta.url), 'utf8');
  assert.match(src, /GITHUB_TOKEN_REQUIRED/);
  assert.match(src, /if \(!github\.configured\(\)\)/);
});

test('login page exists', () => {
  const html = fs.readFileSync(new URL('../public/login.html', import.meta.url), 'utf8');
  assert.match(html, /BUILDER_ACCESS_PASSWORD|Unlock/i);
});

test('settings contains activity log section', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /settingsLogs|Activity log|logOut/);
});
