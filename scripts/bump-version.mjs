#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const next = process.argv[2];
if (!next || !/^\d+\.\d+\.\d+/.test(next)) {
  console.error('Usage: node scripts/bump-version.mjs <x.y.z>');
  process.exit(1);
}
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const prev = pkg.version;
pkg.version = next;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
for (const rel of ['docker-compose.yml', 'solohost/docker-compose.yml']) {
  const p = path.join(root, rel);
  let t = fs.readFileSync(p, 'utf8');
  t = t.replace(new RegExp(`app-builder-pi-solohost:${prev.replace(/\./g, '\\.')}`, 'g'), `app-builder-pi-solohost:${next}`);
  t = t.replace(/app-builder-pi-solohost:\d+\.\d+\.\d+/g, `app-builder-pi-solohost:${next}`);
  fs.writeFileSync(p, t);
}
const htmlPath = path.join(root, 'public/index.html');
let html = fs.readFileSync(htmlPath, 'utf8');
html = html.replace(/app\.js\?v=[^"']+/g, `app.js?v=${next}`);
html = html.replace(/styles\.css\?v=[^"']+/g, `styles.css?v=${next}`);
fs.writeFileSync(htmlPath, html);
const cl = path.join(root, 'CHANGELOG.md');
let changelog = fs.existsSync(cl) ? fs.readFileSync(cl, 'utf8') : '# Changelog\n';
if (!changelog.includes(`## ${next}`)) {
  changelog = changelog.replace('# Changelog', `# Changelog\n\n## ${next}\n- Version bump via scripts/bump-version.mjs\n`);
  fs.writeFileSync(cl, changelog);
}
console.log(`Bumped ${prev} → ${next}`);
