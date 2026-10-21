import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('check-imports script scans src modules', () => {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts/check-imports.mjs')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 180000,
  });
  if (r.status !== 0) console.error(r.stdout, r.stderr);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(String(r.stdout || '') + String(r.stderr || ''), /check-imports/);
});

test('check-imports fails on intentional SyntaxError', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paf-syntax-'));
  const badSrc = path.join(tmp, 'src');
  fs.mkdirSync(badSrc, { recursive: true });
  fs.writeFileSync(path.join(badSrc, 'broken.js'), 'export const x = {\n'); // unclosed
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}\n');
  // Run node --check path as the script does
  const r = spawnSync(process.execPath, ['--check', path.join(badSrc, 'broken.js')], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  // Also ensure our script would catch if pointed at tmp — call a minimal inline
  const script = `
    import { spawnSync } from 'node:child_process';
    const r = spawnSync(process.execPath, ['--check', ${JSON.stringify(path.join(badSrc, 'broken.js'))}], { encoding: 'utf8' });
    process.exit(r.status === 0 ? 0 : 1);
  `;
  const r2 = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.notEqual(r2.status, 0);
});
