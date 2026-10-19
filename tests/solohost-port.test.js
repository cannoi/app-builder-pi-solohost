import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPort } from '../src/release/solohost-port.js';

test('hashPort is stable and in range', () => {
  const a = hashPort('my-app');
  const b = hashPort('my-app');
  assert.equal(a, b);
  assert.ok(a >= 18000 && a <= 18999);
});

test('different slugs usually differ', () => {
  assert.notEqual(hashPort('app-one'), hashPort('app-two'));
});
