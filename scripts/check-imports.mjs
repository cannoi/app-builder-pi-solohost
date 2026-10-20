#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = path.join(root, 'src');
const skip = new Set(['boot.js', 'server.js']);

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.js') && !skip.has(name)) out.push(p);
  }
  return out;
}

const files = walk(srcRoot);
let failed = 0;
for (const file of files) {
  const rel = path.relative(root, file);
  try {
    await import(pathToFileURL(file).href + `?t=${Date.now()}`);
  } catch (err) {
    const msg = String(err?.message || err);
    // Only fail hard on missing named exports / resolve errors from our code
    if (/does not provide an export named|Cannot find module|ERR_MODULE_NOT_FOUND/i.test(msg)) {
      console.error('FAIL', rel, msg.split('\n')[0]);
      failed += 1;
    } else {
      // Side-effect/runtime errors during import are ignored for link check
      console.warn('skip', rel, msg.split('\n')[0].slice(0, 120));
    }
  }
}
if (failed) {
  console.error(`check-imports: ${failed} module(s) failed`);
  process.exit(1);
}
console.log(`check-imports: ${files.length} modules scanned, ok`);
