import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, publicConfig, validateConfig } from '../src/config/index.js';
import { maskKey, maskSecrets, looksLikeSecret } from '../src/utils/mask.js';
import { safeSlug, semverBump } from '../src/utils/ids.js';
import { extractJson } from '../src/utils/validate.js';
import { evaluateCommand, classifyAction } from '../src/security/policy.js';
import { isSafeRelPath } from '../src/utils/fsx.js';

test('config loads without crashing when optional keys are missing', () => {
  const cfg = loadConfig();
  assert.equal(cfg.version, '1.4.15');
  assert.equal(cfg.runtime.mode, 'auto');
  assert.equal(cfg.ai.provider, 'deepseek');
  assert.equal(cfg.ai.deepseekModel, 'deepseek-flash');
  assert.equal(cfg.docker, undefined);
  const pub = publicConfig(cfg);
  assert.equal(typeof pub.ai.geminiConfigured, 'boolean');
  const v = validateConfig(cfg);
  assert.equal(v.ok, true);
});

test('secrets are masked', () => {
  assert.match(maskKey('AIzaSyDummyKeyValueXXXX'), /\*\*\*\*/);
  assert.doesNotMatch(maskSecrets('GEMINI_API_KEY=AIzaSyDummyKeyValueXXXX'), /AIzaSyDummyKeyValueXXXX/);
  assert.equal(looksLikeSecret('AIzaSyABCDEFGHIJKLMNOPQRSTUVWX'), true);
});

test('slug and semver helpers', () => {
  assert.equal(safeSlug('Pi Subscription App!'), 'pi-subscription-app');
  assert.equal(semverBump('0.1.0', 'patch'), '0.1.1');
});

test('JSON extraction tolerates fences', () => {
  const j = extractJson('```json\n{"name":"x"}\n```');
  assert.equal(j.name, 'x');
});

test('command policy blocks dangerous actions', () => {
  assert.equal(evaluateCommand('rm -rf /').ok, false);
  assert.equal(evaluateCommand('npm test').ok, true);
  assert.equal(evaluateCommand('docker build .', { dockerMode: 'safe' }).ok, false);
  assert.equal(evaluateCommand('docker build .', { dockerMode: 'power' }).ok, true);
  assert.equal(classifyAction('read_project'), 'SAFE');
  assert.equal(classifyAction('push_github'), 'CONFIRM');
  assert.equal(classifyAction('format_disk'), 'BLOCKED');
});

test('path safety', () => {
  assert.equal(isSafeRelPath('../etc/passwd'), false);
  assert.equal(isSafeRelPath('/etc/passwd'), false);
  assert.equal(isSafeRelPath('src/server.js'), true);
});
