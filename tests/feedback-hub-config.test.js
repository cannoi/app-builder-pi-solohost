import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'cannoi_7Kp9xV2mQ8rN4tY6cL3wA5zD1eF0uH9';

test('ingest token literal exists only in hub-config.js under src', () => {
  const hits = [];
  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'data', 'tests', 'removed-files-backup'].includes(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (/\.(js|cjs|mjs|html|json|yml|md)$/.test(ent.name)) {
        const text = fs.readFileSync(full, 'utf8');
        if (text.includes(TOKEN)) hits.push(path.relative(root, full));
      }
    }
  }
  walk(path.join(root, 'src'));
  walk(path.join(root, 'public'));
  assert.deepEqual(hits, ['src/feedback/hub-config.js'], hits.join(', '));
});

test('public feedback config has no token', async () => {
  const { publicFeedbackConfig, ingestToken } = await import('../src/feedback/hub-config.js');
  const pub = publicFeedbackConfig();
  assert.ok(ingestToken);
  assert.equal(pub.ingestToken, undefined);
  assert.ok(pub.hubId);
});

test('maskSecrets redacts cannoi_ tokens', async () => {
  const { maskSecrets } = await import('../src/utils/mask.js');
  assert.match(maskSecrets('token cannoi_7Kp9xV2mQ8rN4tY6cL3wA5zD1eF0uH9 x'), /cannoi_\*\*\*/);
});
