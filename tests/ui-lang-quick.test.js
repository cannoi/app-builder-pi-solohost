import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Run Publish Donate sit above chat textarea', () => {
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  const iQa = html.indexOf('id="quickActions"');
  const iMsg = html.indexOf('id="message"');
  assert.ok(iQa > 0 && iMsg > iQa);
  assert.match(html, /id="btnRun"/);
  assert.match(html, /id="btnPublish"/);
  assert.match(html, /id="btnDonate"/);
});

test('language toggle is in top bar after settings, not in settings sheet', () => {
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  assert.match(html, /id="langToggle"/);
  assert.doesNotMatch(html, /id="langEn"/);
  assert.doesNotMatch(html, /id="langVi"/);
  const iSet = html.indexOf('settingsBtn');
  const iLang = html.indexOf('langToggle');
  const iSettingsModal = html.indexOf('id="settings"');
  assert.ok(iSet < iLang && iLang < iSettingsModal);
});

test('i18n toggles EN/VI and applies qa labels', () => {
  const src = fs.readFileSync(path.join(root, 'public/i18n.js'), 'utf8');
  const document = {
    readyState: 'complete',
    documentElement: { lang: 'en' },
    getElementById: (id) => {
      if (id === 'langToggle') return { textContent: 'EN', addEventListener() {} };
      return null;
    },
    querySelectorAll: (sel) => {
      if (sel === '[data-i18n]') {
        return [{ getAttribute: () => 'qa.run', textContent: '' }];
      }
      return [];
    },
    addEventListener() {},
  };
  const sandbox = {
    window: {},
    document,
    localStorage: { store: {}, getItem(k) { return this.store[k] || null; }, setItem(k, v) { this.store[k] = String(v); } },
    navigator: { language: 'en-US' },
    CustomEvent: class { constructor(n, o) { this.type = n; this.detail = o?.detail; } },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(src, sandbox);
  assert.equal(sandbox.pafI18n.getLocale(), 'en');
  sandbox.pafI18n.setLocale('vi');
  assert.equal(sandbox.pafI18n.getLocale(), 'vi');
  assert.equal(sandbox.pafI18n.t('qa.publish'), '🚀 Xuất bản');
  sandbox.pafI18n.setLocale('en');
  assert.equal(sandbox.pafI18n.t('qa.run'), '▶ Run');
});

test('remote URL can use SoloHost PUBLIC_IP + HOST_PORT', async () => {
  const { resolvePublicUrl } = await import('../src/remote/info.js');
  const prev = { ...process.env };
  process.env.PUBLIC_IP = '203.0.113.9';
  process.env.HOST_PORT = '18781';
  delete process.env.PUBLIC_URL;
  try {
    const r = await resolvePublicUrl({ cfg: {}, req: { headers: { host: '127.0.0.1:8080' } }, dataDir: '/tmp' });
    assert.equal(r.publicUrl, 'http://203.0.113.9:18781');
    assert.equal(r.source, 'solohost');
  } finally {
    process.env.PUBLIC_URL = prev.PUBLIC_URL;
    process.env.PUBLIC_IP = prev.PUBLIC_IP;
    process.env.HOST_PORT = prev.HOST_PORT;
  }
});

test('remote info uses shared access password flag', () => {
  const src = fs.readFileSync(path.join(root, 'src/api/routes.js'), 'utf8');
  assert.match(src, /passwordEnabled = Boolean\(cfg\.accessPassword\)/);
});

test('welcome and more-menu i18n keys exist in EN and VI', () => {
  const src = fs.readFileSync(path.join(root, 'public/i18n.js'), 'utf8');
  for (const key of ['welcome.title', 'welcome.body', 'welcome.idea', 'more.zip', 'more.rollback', 'qa.run']) {
    assert.match(src, new RegExp("'" + key.replace('.', '\\.') + "'"));
  }
  const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
  assert.match(app, /function renderWelcome/);
  assert.match(app, /uiT\('welcome\.body'/);
  assert.match(app, /action === 'rollback'/);
  assert.match(app, /quick\('publish'/);
  assert.match(app, /quick\('export'\)/);
  assert.doesNotMatch(app, /typeof rollback === 'function'/);
});

test('more menu buttons use data-i18n single language labels', () => {
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  assert.match(html, /data-more="export"[^>]*data-i18n="more\.zip"/);
  assert.match(html, /data-more="rollback"[^>]*data-i18n="more\.rollback"/);
  assert.doesNotMatch(html, /Tải ZIP \/ Download ZIP/);
});
