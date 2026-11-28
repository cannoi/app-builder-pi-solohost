import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildAiProjectContext } from '../src/services/project-context-resolver.js';

test('improve context is lean: inventory + few bodies', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-lean-'));
  await fs.writeFile(path.join(dir, 'server.js'), 'x'.repeat(5000));
  await fs.writeFile(path.join(dir, 'package.json'), '{"name":"t"}');
  for (let i = 0; i < 20; i++) await fs.writeFile(path.join(dir, `f${i}.js`), `export const n=${i};\n` + 'y'.repeat(2000));
  const r = await buildAiProjectContext(null, { sourceDir: dir, mode: 'improve', query: 'fix the form button' });
  assert.match(r.text, /FILE INVENTORY/);
  assert.match(r.text, /NEED_FILES|need_files/i);
  assert.ok(r.text.length < 30000, `context too large: ${r.text.length}`);
  assert.ok(r.selectedFiles.length <= 14, `too many bodies: ${r.selectedFiles.length}`);
});
