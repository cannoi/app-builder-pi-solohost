import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256, fileClass } from '../src/utils/hash.js';

test('sha256 known vector', () => {
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('protected file policy', () => {
  assert.equal(fileClass('.env'), 'ABSOLUTELY_PROTECTED');
  assert.equal(fileClass('config/.env'), 'ABSOLUTELY_PROTECTED');
  assert.equal(fileClass('.env.example'), 'AUTO_MODIFIABLE_TEMPLATE');
  assert.equal(fileClass('server.js'), 'NORMAL_SOURCE');
});
