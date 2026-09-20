import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('default compose uses the public image and has no Docker socket mount', () => {
  const compose = fs.readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
  assert.match(compose, /ghcr\.io\/cannoi\/app-builder-pi-solohost:latest/);
  assert.doesNotMatch(compose, /docker\.sock/i);
  assert.doesNotMatch(compose, /build:\s*\./i);
});

test('SoloHost compose uses the public image and has no Docker socket mount', () => {
  const compose = fs.readFileSync(new URL('../solohost/docker-compose.yml', import.meta.url), 'utf8');
  assert.match(compose, /ghcr\.io\/cannoi\/app-builder-pi-solohost:latest/);
  assert.doesNotMatch(compose, /docker\.sock/i);
});
