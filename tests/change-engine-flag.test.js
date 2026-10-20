import test from 'node:test';
import assert from 'node:assert/strict';
import { isChangeEngineV2Enabled } from '../src/engine/flags.js';
import { applyEditsInMemory } from '../src/engine/edits.js';

test('flag default off', () => {
  assert.equal(isChangeEngineV2Enabled({}), false);
  assert.equal(isChangeEngineV2Enabled({ CHANGE_ENGINE_V2: 'true' }), true);
  assert.equal(isChangeEngineV2Enabled({ CHANGE_ENGINE_V2: '0' }), false);
});

test('MODIFY medium risk path can apply in memory without legacy full-file', () => {
  const map = { 'public/app.js': 'const color = "red";\n' };
  const r = applyEditsInMemory(map, [
    { path: 'public/app.js', op: 'replace', search: 'const color = "red";', replace: 'const color = "blue";' },
  ]);
  assert.equal(r.ok, true);
  assert.match(r.files['public/app.js'], /blue/);
});
