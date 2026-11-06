import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readTemplateCatalog,
  getTemplateById,
  matchTemplates,
} from '../src/templates/library.js';
import { parseGithubFetch } from '../src/templates/fetch-upstream.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');

test('thin overlays are tiny and instantiable', async () => {
  for (const id of ['uptime-kuma', 'filebrowser', 'homepage', 'gitea', 'vaultwarden', 'changedetection']) {
    const t = await getTemplateById(DIR, id);
    assert.ok(t, id);
    assert.equal(t.instantiable, true);
    assert.ok(t.fetch?.owner && t.fetch?.repo && t.fetch?.ref, id);
    const entries = await fs.readdir(path.join(DIR, id), { withFileTypes: true });
    // Must not vendor full upstream trees
    assert.ok(!entries.some((e) => e.name === 'node_modules'));
    assert.ok(await fs.readFile(path.join(DIR, id, 'docker-compose.yml'), 'utf8'));
    assert.ok(await fs.readFile(path.join(DIR, id, 'config_options.yml'), 'utf8'));
    const compose = await fs.readFile(path.join(DIR, id, 'docker-compose.yml'), 'utf8');
    assert.match(compose, /127\.0\.0\.1/);
    assert.doesNotMatch(compose, /docker\.sock:/i);
    assert.doesNotMatch(compose, /privileged:\s*true/i);
  }
});

test('std templates are complete SoloHost apps not empty stubs', async () => {
  const t = await getTemplateById(DIR, 'std-business-crm');
  assert.ok(t?.instantiable);
  await fs.access(path.join(DIR, 'std-business-crm', 'src', 'server.js'));
  await fs.access(path.join(DIR, 'std-business-crm', 'Dockerfile'));
  await fs.access(path.join(DIR, 'std-business-crm', 'config_options.yml'));
});

test('parseGithubFetch reads owner/repo', () => {
  const g = parseGithubFetch({ owner: 'louislam', repo: 'uptime-kuma', ref: '1.23.16' });
  assert.equal(g.owner, 'louislam');
  assert.equal(g.ref, '1.23.16');
});

test('monitoring match can select thin uptime-kuma', async () => {
  const m = await matchTemplates(DIR, 'uptime kuma monitoring status', { limit: 8 });
  assert.ok(m.selected_template_id);
  const all = await readTemplateCatalog(DIR);
  assert.ok(all.some((x) => x.id === m.selected_template_id));
});
