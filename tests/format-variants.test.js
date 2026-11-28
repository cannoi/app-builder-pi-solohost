import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeShape, parseJsonLenient } from '../src/ai/response-doctor.js';
import { interpretJsonAnswer } from '../src/ai/client.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function validPatch(v) {
  return Boolean(v && typeof v === 'object' && !Array.isArray(v)
    && (Array.isArray(v.files) || Array.isArray(v.edits) || Array.isArray(v.new_files) || Array.isArray(v.need_files)));
}

test('normalizeShape accepts changes/patches aliases', () => {
  const a = normalizeShape({ changes: [{ path: 'a.js', content: 'x' }] });
  assert.ok(Array.isArray(a.files));
  assert.equal(a.files[0].path, 'a.js');
  const b = normalizeShape({ patches: [{ path: 'b.js', search: 'old', replace: 'new' }] });
  assert.ok(Array.isArray(b.edits));
  assert.equal(b.edits[0].search, 'old');
});

test('normalizeShape unwraps data/result wrappers', () => {
  const v = normalizeShape({ data: { result: { files: [{ file: 'x.js', code: '1' }] } } });
  assert.equal(v.files[0].path, 'x.js');
  assert.equal(v.files[0].content, '1');
});

test('normalizeShape maps edit search aliases', () => {
  const v = normalizeShape({
    edits: [{ file: 'public/index.html', old_string: '<h1>A</h1>', new_string: '<h1>B</h1>' }],
  });
  assert.equal(v.edits[0].path, 'public/index.html');
  assert.equal(v.edits[0].search, '<h1>A</h1>');
  assert.equal(v.edits[0].replace, '<h1>B</h1>');
});

test('interpretJsonAnswer accepts fenced JSON with files alias', () => {
  const raw = { text: '```json\n{"file_changes":[{"path":"s.js","content":"ok"}]}\n```' };
  const r = interpretJsonAnswer(raw, validPatch);
  assert.equal(r.ok, true);
  assert.equal(r.value.files[0].content, 'ok');
});

test('chat Enter-to-send is wired (Shift+Enter keeps newline)', () => {
  const app = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app.js'), 'utf8');
  assert.match(app, /if \(e\.key !== 'Enter'\) return/);
  assert.match(app, /if \(e\.shiftKey\) return/);
  assert.match(app, /handleTextCommand/);
  // Must not require ctrl/meta exclusively
  assert.doesNotMatch(app, /Enter' && \(e\.ctrlKey \|\| e\.metaKey\)/);
});
