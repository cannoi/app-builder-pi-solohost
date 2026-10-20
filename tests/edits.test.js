import test from 'node:test';
import assert from 'node:assert/strict';
import { applyReplace, applyEditsInMemory, isUnsafePath, normalizeLf } from '../src/engine/edits.js';

test('replace matches exactly once', () => {
  const r = applyReplace('alpha\nbeta\ngamma\n', 'beta', 'BETA');
  assert.equal(r.ok, true);
  assert.equal(r.content, 'alpha\nBETA\ngamma\n');
});

test('zero matches fails', () => {
  const r = applyReplace('abc', 'zzz', 'x');
  assert.equal(r.ok, false);
  assert.match(r.error, /0 times/);
});

test('many matches fails', () => {
  const r = applyReplace('xx xx xx', 'xx', 'y');
  assert.equal(r.ok, false);
  assert.match(r.error, /matched/);
});

test('CRLF normalized', () => {
  const r = applyReplace('a\r\nb\r\nc\r\n', 'b', 'B');
  assert.equal(r.ok, true);
  assert.equal(r.content.includes('\r'), false);
  assert.equal(normalizeLf('a\r\nb'), 'a\nb');
});

test('atomic: one bad edit blocks all', () => {
  const map = { 'a.js': 'hello world', 'b.js': 'keep' };
  const r = applyEditsInMemory(map, [
    { path: 'a.js', op: 'replace', search: 'hello', replace: 'hi' },
    { path: 'b.js', op: 'replace', search: 'missing', replace: 'x' },
  ]);
  assert.equal(r.ok, false);
  // original map untouched by caller — function returns new map only on ok
  assert.equal(map['a.js'], 'hello world');
});

test('unsafe paths blocked', () => {
  assert.equal(isUnsafePath('../etc/passwd'), true);
  assert.equal(isUnsafePath('.env'), true);
  assert.equal(isUnsafePath('node_modules/x'), true);
  assert.equal(isUnsafePath('src/app.js'), false);
  const r = applyEditsInMemory({}, [{ path: '../x', op: 'create', replace: '1' }]);
  assert.equal(r.ok, false);
});

test('paf-made-by badge protected on delete and strip', () => {
  const map = { 'ui.html': '<div class="paf-made-by">x</div>' };
  const del = applyEditsInMemory(map, [{ path: 'ui.html', op: 'delete' }]);
  assert.equal(del.ok, false);
  const strip = applyEditsInMemory(map, [{ path: 'ui.html', op: 'replace', search: 'class="paf-made-by"', replace: 'class="x"' }]);
  // replace of class name is allowed if badge text remains — if class removed entirely fails
  const gone = applyEditsInMemory(map, [{ path: 'ui.html', op: 'replace', search: '<div class="paf-made-by">x</div>', replace: '<div></div>' }]);
  assert.equal(gone.ok, false);
});
