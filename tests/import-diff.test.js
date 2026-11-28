import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { snapshotTree, diffTrees, formatDiffBrief } from '../src/projects/import-diff.js';

test('diff detects added removed modified', async () => {
  const a = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-a-'));
  const b = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-b-'));
  await fs.writeFile(path.join(a, 'keep.js'), 'same');
  await fs.writeFile(path.join(a, 'gone.js'), 'x');
  await fs.writeFile(path.join(a, 'edit.js'), 'old');
  await fs.writeFile(path.join(b, 'keep.js'), 'same');
  await fs.writeFile(path.join(b, 'edit.js'), 'new');
  await fs.writeFile(path.join(b, 'new.js'), 'y');
  const before = await snapshotTree(a);
  const after = await snapshotTree(b);
  const d = diffTrees(before, after);
  assert.equal(d.summary.added, 1);
  assert.equal(d.summary.removed, 1);
  assert.equal(d.summary.modified, 1);
  assert.match(formatDiffBrief(d), /Added: 1/);
});
