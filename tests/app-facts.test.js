import test from 'node:test';
import assert from 'node:assert/strict';
import { APP_FACTS, coreKnowledge, panelKnowledge, builderKnowledge } from '../src/ai/app-facts.js';
import fs from 'node:fs';

test('facts include current package version', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(APP_FACTS.version, pkg.version);
});

test('core knowledge stays short', () => {
  assert.ok(coreKnowledge('en').length < 700);
  assert.ok(coreKnowledge('vi').length < 700);
});

test('panel knowledge stays under budget', () => {
  const k = panelKnowledge({ message: 'how do I publish and choose install fields?' });
  assert.ok(k.length <= 2500);
  assert.match(k, /full|defaults|auth|custom/i);
});

test('builder knowledge keeps contract phrases', () => {
  const k = builderKnowledge();
  assert.match(k, /Upgrade is separate from Build/);
  assert.match(k, /deployment artifact/);
  assert.match(k, /config_options\.yml/);
  assert.match(k, /pi\.ui\.primary/);
});
