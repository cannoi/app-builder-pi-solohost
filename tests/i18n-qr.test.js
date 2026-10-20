import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('i18n.js is a classic script with matching en/vi keys', () => {
  const src = fs.readFileSync(path.join(root, 'public/i18n.js'), 'utf8');
  assert.doesNotMatch(src, /\bexport\s+/); // no ESM export keyword
  assert.doesNotMatch(src, /export\s+\{/);
  const sandbox = {
    window: {},
    document: {
      readyState: 'complete',
      documentElement: { lang: 'en' },
      querySelectorAll: () => [],
      getElementById: () => null,
      addEventListener() {},
    },
    localStorage: { getItem: () => null, setItem() {} },
    navigator: { language: 'en' },
    CustomEvent: class { constructor(n, o) { this.detail = o?.detail; } },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(src, sandbox);
  assert.ok(sandbox.pafI18n);
  const en = Object.keys(sandbox.pafI18n.dict.en).sort();
  const vi = Object.keys(sandbox.pafI18n.dict.vi).sort();
  assert.deepEqual(en, vi);
});

test('qrcode-lite draws modules without network', () => {
  const src = fs.readFileSync(path.join(root, 'public/qrcode-lite.js'), 'utf8');
  let fillCount = 0;
  const canvas = {
    width: 0,
    height: 0,
    getContext() {
      return {
        fillStyle: '',
        fillRect() { fillCount += 1; },
      };
    },
  };
  const sandbox = { window: {}, globalThis: {} };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(src, sandbox);
  assert.ok(sandbox.PafQR?.renderToCanvas);
  sandbox.PafQR.renderToCanvas('https://203.0.113.5:18781', canvas, 160);
  assert.ok(fillCount > 10, `expected QR modules, got fillRect=${fillCount}`);
});

test('index loads qrcode-lite before ai-panel', () => {
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  const i = html.indexOf('qrcode-lite.js');
  const j = html.indexOf('ai-panel.js');
  assert.ok(i >= 0 && j > i);
});
