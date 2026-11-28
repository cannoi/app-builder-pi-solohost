import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectComposeVarNames,
  buildDeclaredConfigOptions,
} from '../src/release/solohost.js';

test('collectComposeVarNames finds interpolations', () => {
  const names = collectComposeVarNames('environment:\n  A: ${AI_HUB_ADMIN_PASSWORD}\n  B: ${HOST_PORT:-8080}\n');
  assert.ok(names.includes('AI_HUB_ADMIN_PASSWORD'));
  assert.ok(names.includes('HOST_PORT'));
});

test('buildDeclaredConfigOptions declares secrets as fields and others fixed', () => {
  const compose = `services:\n  app:\n    image: ghcr.io/o/a:latest\n    environment:\n      AI_HUB_ADMIN_PASSWORD: \${AI_HUB_ADMIN_PASSWORD}\n      HOST_PORT: \${HOST_PORT}\n      AI_MODEL: \${AI_MODEL}\n`;
  const cfg = buildDeclaredConfigOptions({
    project: { name: 'Hub' },
    composeText: compose,
    hostPort: 32100,
    containerPort: 8080,
  });
  assert.match(cfg, /name: AI_HUB_ADMIN_PASSWORD/);
  assert.match(cfg, /type: password/);
  assert.match(cfg, /fixed_values:/);
  assert.match(cfg, /name: HOST_PORT/);
  assert.match(cfg, /"32100"/);
  assert.match(cfg, /name: AI_MODEL/);
  // every compose var mentioned
  for (const v of collectComposeVarNames(compose)) {
    assert.match(cfg, new RegExp(`name: ${v}`));
  }
});
