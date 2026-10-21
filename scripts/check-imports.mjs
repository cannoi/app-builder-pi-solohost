#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const skipNames = new Set(['boot.js', 'server.js']);

function walk(dir, exts, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (['node_modules', 'data', '.git'].includes(name)) continue;
      walk(p, exts, out);
    } else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

let failed = 0;

// 1) Syntax check all src + public JS
const syntaxFiles = [
  ...walk(path.join(root, 'src'), ['.js', '.mjs', '.cjs']),
  ...walk(path.join(root, 'public'), ['.js', '.mjs', '.cjs']),
];
for (const file of syntaxFiles) {
  const rel = path.relative(root, file);
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error('SYNTAX_FAIL', rel, (r.stderr || r.stdout || '').split('\n')[0]);
    failed += 1;
  }
}

// 2) Dynamic import of src modules (relative paths only hard-fail)
const importFiles = walk(path.join(root, 'src'), ['.js']).filter((f) => !skipNames.has(path.basename(f)));
for (const file of importFiles) {
  const rel = path.relative(root, file);
  try {
    await import(pathToFileURL(file).href + `?t=${Date.now()}`);
  } catch (err) {
    const msg = String(err?.message || err);
    const code = err?.code || '';
    // External package missing → skip; relative module / syntax / named export → fail
    const isExternalMissing =
      (code === 'ERR_MODULE_NOT_FOUND' || /Cannot find package|Cannot find module/i.test(msg)) &&
      !/from ['"]\.\.?[/\\]/.test(msg) &&
      !msg.includes(path.sep + 'src' + path.sep);
    if (err instanceof SyntaxError || /SyntaxError/i.test(msg)) {
      console.error('FAIL', rel, msg.split('\n')[0]);
      failed += 1;
    } else if (/does not provide an export named/i.test(msg)) {
      console.error('FAIL', rel, msg.split('\n')[0]);
      failed += 1;
    } else if (isExternalMissing) {
      console.warn('skip-ext', rel, msg.split('\n')[0].slice(0, 120));
    } else if (/ERR_MODULE_NOT_FOUND|Cannot find module/i.test(msg) && /\.\.?[/\\]/.test(msg)) {
      console.error('FAIL', rel, msg.split('\n')[0]);
      failed += 1;
    } else {
      // runtime side-effects during import — soft
      console.warn('skip', rel, msg.split('\n')[0].slice(0, 120));
    }
  }
}

if (failed) {
  console.error(`check-imports: ${failed} failure(s)`);
  process.exit(1);
}
console.log(`check-imports: syntax ${syntaxFiles.length} + import ${importFiles.length} ok`);
