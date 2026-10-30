import test from 'node:test';
import assert from 'node:assert/strict';

// Access password gate was removed in 1.8.x (SoloHost loopback + no install password).
test('access password module is intentionally absent', async () => {
  let err = null;
  try {
    await import('../src/http-access-auth.js');
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'http-access-auth.js should not exist');
});

test('host allowlist FORBIDDEN_HOST string is gone', async () => {
  const fs = await import('node:fs');
  const http = fs.readFileSync(new URL('../src/http.js', import.meta.url), 'utf8');
  assert.equal(http.includes('FORBIDDEN_HOST'), false);
});
