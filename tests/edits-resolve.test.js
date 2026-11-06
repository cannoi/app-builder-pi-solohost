import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyEdits, resolveSearch } from '../src/jobs/edits.js';

test('exact unique search applies', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ed-'));
  await fs.writeFile(path.join(dir, 'a.html'), '<div>Hello</div>\n<div>World</div>\n');
  const r = await applyEdits({
    sourceDir: dir,
    edits: [{ path: 'a.html', search: '<div>Hello</div>', replace: '<div>Hi</div>' }],
  });
  assert.equal(r.ok, true);
  assert.match(r.files[0].content, /Hi/);
});

test('ambiguous short search fails with multi snippets', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ed-'));
  const html = '<input name="search"/>\n<label>search</label>\n<button>search</button>\n';
  await fs.writeFile(path.join(dir, 'public/index.html'), html, { recursive: true }).catch(async () => {
    await fs.mkdir(path.join(dir, 'public'), { recursive: true });
    await fs.writeFile(path.join(dir, 'public/index.html'), html);
  });
  const r = await applyEdits({
    sourceDir: dir,
    edits: [{ path: 'public/index.html', search: 'search', replace: 'find' }],
  });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].reason, 'ambiguous');
  assert.match(String(r.errors[0].snippet || r.errors[0].detail), /match #|occurs/i);
});

test('line-trim unique match tolerates indentation drift', async () => {
  const content = 'function x() {\n  return 1;\n}\n';
  const search = 'function x() {\nreturn 1;\n}'; // missing indent on middle line after trim match
  // trim match compares trimmed lines so middle "return 1;" matches "  return 1;"
  const resolved = resolveSearch(content, 'function x() {\nreturn 1;\n}');
  assert.equal(resolved.ok, true, JSON.stringify(resolved));
  const out = resolved.apply('function x() {\n  return 2;\n}');
  assert.match(out, /return 2/);
});

test('soft whitespace unique match', () => {
  const content = 'const  a   =  1;\nconst b = 2;\n';
  const resolved = resolveSearch(content, 'const a = 1;');
  assert.equal(resolved.ok, true, JSON.stringify(resolved));
  const out = resolved.apply('const a = 3;');
  assert.match(out, /const a = 3/);
});
