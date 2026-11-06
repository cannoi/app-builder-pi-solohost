import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintPackage } from '../src/release/solohost-lint.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'solohost');

for (const name of ['web-app', 'openclaw', 'hermes', 'select-set-example']) {
  test(`official fixture ${name} has zero lint errors`, () => {
    const composeText = fs.readFileSync(path.join(root, name, 'docker-compose.yml'), 'utf8');
    const configText = fs.readFileSync(path.join(root, name, 'config_options.yml'), 'utf8');
    const r = lintPackage({ composeText, configText });
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors, null, 2));
  });
}
