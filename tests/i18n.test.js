import test from 'node:test';
import assert from 'node:assert/strict';
import { t, catalog, locales } from '../src/i18n/index.js';

test('every solohost key exists in en', () => {
  const en = catalog('en');
  const keys = Object.keys(en).filter((k) => k.startsWith('solohost.'));
  assert.ok(keys.length >= 10);
  for (const k of keys) {
    assert.equal(typeof en[k], 'string');
    assert.ok(en[k].length > 0);
  }
});

test('unknown locale falls back to English', () => {
  assert.equal(t('xx', 'solohost.kit.title'), t('en', 'solohost.kit.title'));
});

test('vi overrides kit title', () => {
  assert.notEqual(t('vi', 'solohost.kit.title'), t('en', 'solohost.kit.title'));
});

test('locales include en and vi', () => {
  assert.ok(locales.includes('en'));
  assert.ok(locales.includes('vi'));
});
