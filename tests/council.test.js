import test from 'node:test';
import assert from 'node:assert/strict';
import { pickRoles, scoreOf } from '../src/ai/council.js';

test('council prefers the model with a better trust score when both keys exist', () => {
  const db = { setting() { return { deepseek: { wins: 8, fails: 1, ms: 2000 }, gemini: { wins: 1, fails: 4, ms: 9000 } }; } };
  const roles = pickRoles({ ai: { deepseekKey: 'a', geminiKey: 'b' } }, db);
  assert.equal(roles.builder, 'deepseek');
  assert.equal(roles.reviewer, 'gemini');
  assert.ok(scoreOf(roles.trust.deepseek) > scoreOf(roles.trust.gemini));
});

test('council degrades to a single builder when only one key is set', () => {
  const db = { setting() { return { deepseek: { wins: 1, fails: 0, ms: 2000 }, gemini: { wins: 1, fails: 0, ms: 2000 } }; } };
  const roles = pickRoles({ ai: { deepseekKey: 'a', geminiKey: '' } }, db);
  assert.equal(roles.builder, 'deepseek');
  assert.equal(roles.reviewer, null);
});
