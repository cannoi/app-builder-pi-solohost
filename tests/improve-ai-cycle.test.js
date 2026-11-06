import test from 'node:test';
import assert from 'node:assert/strict';
import { loadNeedFileSnippets } from '../src/jobs/improve-ai-cycle.js';
import { parseNeedFiles } from '../src/ai/response-doctor.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

test('loadNeedFileSnippets reads file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-need-'));
  await fs.writeFile(path.join(dir, 'server.js'), 'export const x = 1;\n');
  const sn = await loadNeedFileSnippets(dir, ['server.js']);
  assert.equal(sn[0].path, 'server.js');
  assert.match(sn[0].content, /export const x/);
});

test('NEED_FILES protocol parses', () => {
  assert.deepEqual(parseNeedFiles('[NEED_FILES: a.js, b.js]').slice(0, 2), ['a.js', 'b.js']);
});
