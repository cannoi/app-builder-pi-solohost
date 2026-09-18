import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('default compose builds the factory and mounts the Docker socket', () => {
  const compose = fs.readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
  assert.match(compose, /build:\s*\./);
  assert.match(compose, /docker\.sock/);
  assert.match(compose, /18795:8080/);
});
