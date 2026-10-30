import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { remapAndFilterPatchFiles } from '../src/jobs/path-safety.js';

test('remaps src/server.js to server.js when only root exists', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-remap-'));
  await fs.writeFile(path.join(dir, 'server.js'), 'export default 1\n');
  const r = await remapAndFilterPatchFiles({
    sourceDir: dir,
    files: [{ path: 'src/server.js', content: 'export default 2\n' }],
    allowImplicitNew: true,
  });
  assert.ok(r.files.some((f) => f.path === 'server.js'));
  assert.ok((r.remapped || []).some((x) => x.from === 'src/server.js'));
});
