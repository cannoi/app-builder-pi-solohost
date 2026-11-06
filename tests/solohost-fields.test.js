import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  inventoryFields, suggestPolicy, applyPolicyToVars, classifyVar, isSecretName,
} from '../src/release/solohost-fields.js';
import { writeSoloHostPackage } from '../src/release/solohost.js';
import { lintPackage } from '../src/release/solohost-lint.js';

const NAMES = [
  'ADMIN_PASSWORD', 'AI_API_KEY', 'AI_PROVIDER', 'AI_TIMEOUT_MS', 'PORT', 'DATA_DIR',
  'FEATURE_FLAG', 'LOG_LEVEL', 'HOST', 'GATEWAY_TOKEN',
];

test('classifyVar heuristics', () => {
  assert.equal(classifyVar('ADMIN_PASSWORD'), 'auth');
  assert.equal(classifyVar('AI_API_KEY'), 'credential');
  assert.equal(classifyVar('AI_PROVIDER'), 'feature');
  assert.equal(classifyVar('AI_TIMEOUT_MS'), 'tuning');
  assert.equal(classifyVar('PORT'), 'internal');
  assert.equal(classifyVar('USERNAME'), 'auth');
});

test('full mode keeps non-internal', () => {
  const inv = inventoryFields(NAMES);
  const pol = suggestPolicy(inv, 'full');
  const applied = applyPolicyToVars(NAMES, pol);
  assert.ok(applied.keep.includes('ADMIN_PASSWORD'));
  assert.ok(!applied.keep.includes('PORT'));
});

test('defaults mode omits non-internal', () => {
  const inv = inventoryFields(NAMES);
  const pol = suggestPolicy(inv, 'defaults');
  const applied = applyPolicyToVars(NAMES, pol);
  assert.ok(applied.omit.includes('ADMIN_PASSWORD'));
});

test('auth mode keeps auth; core credential needs confirmation', () => {
  const inv = inventoryFields(NAMES);
  const pol = suggestPolicy(inv, 'auth');
  assert.ok(pol.needs_confirmation?.some((x) => x.name === 'AI_API_KEY'));
  const applied = applyPolicyToVars(NAMES, pol);
  assert.ok(applied.keep.includes('ADMIN_PASSWORD') || applied.keep.includes('GATEWAY_TOKEN'));
});

test('never fix secrets into fixedValues', () => {
  const applied = applyPolicyToVars(['API_KEY'], {
    mode: 'custom',
    fields: { API_KEY: 'fixed' },
    fixedValues: { API_KEY: 'sk-leak' },
  });
  assert.ok(!applied.fixedValues.API_KEY);
  assert.ok(isSecretName('API_KEY'));
});

test('policy modes produce lint-clean packages on existing compose', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sh-fields-'));
  const compose = `services:
  app:
    image: ghcr.io/demo/sample:1
    labels:
      pi.ui.primary: "true"
    ports:
      - "127.0.0.1:18150:8080"
    environment:
      ADMIN_PASSWORD: \${ADMIN_PASSWORD}
      AI_API_KEY: \${AI_API_KEY}
      AI_PROVIDER: \${AI_PROVIDER}
      AI_TIMEOUT_MS: \${AI_TIMEOUT_MS}
      FEATURE_FLAG: \${FEATURE_FLAG}
`;
  await fs.writeFile(path.join(dir, 'docker-compose.yml'), compose);
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'sample', version: '1.0.0' }));
  const inv = inventoryFields(['ADMIN_PASSWORD', 'AI_API_KEY', 'AI_PROVIDER', 'AI_TIMEOUT_MS', 'FEATURE_FLAG']);
  for (const mode of ['full', 'defaults', 'auth', 'custom']) {
    const pol = suggestPolicy(inv, mode);
    // defaults/auth omit many → need volume which writeSoloHostPackage adds
    const result = await writeSoloHostPackage({
      project: { name: 'sample', slug: 'sample', idea: 'demo' },
      sourceDir: dir,
      image: 'ghcr.io/demo/sample:1',
      hostPort: 18150,
      fieldPolicy: pol,
    });
    const outCompose = await fs.readFile(path.join(dir, 'solohost', 'docker-compose.yml'), 'utf8');
    const outConfig = await fs.readFile(path.join(dir, 'solohost', 'config_options.yml'), 'utf8');
    const lint = lintPackage({ composeText: outCompose, configText: outConfig, policy: pol });
    assert.equal(lint.errors.length, 0, `${mode}: ${JSON.stringify(lint.errors)}`);
    // no secrets in fixed_values
    assert.doesNotMatch(outConfig, /value:\s*["']?sk-/);
    // internal never as form field with type text for PORT
    assert.doesNotMatch(outConfig, /name:\s*PORT\n\s+type:\s*text/);
  }
});
