import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { PROVIDER_CATALOG } from '../src/ai/hub/catalog.js';
import { loadConfig } from '../src/config/loader.js';
import {
  SUPPORTED_UI_LOCALES,
  detectUserLanguage,
  resolveEffectiveLanguage,
  languageInstructionFor,
} from '../src/ai/language.js';
import { t as serverT } from '../src/i18n/index.js';
import { stampMadeBy, isMadeByEnabled } from '../src/projects/badge.js';
import { writeSoloHostPackage } from '../src/release/solohost.js';
import { lintPackage } from '../src/release/solohost-lint.js';

test('Gemini is default provider and catalog includes popular AI providers', () => {
  const cfg = loadConfig({ ...process.env, AI_PROVIDER: '' });
  assert.equal(cfg.ai.provider, 'gemini');
  assert.equal(PROVIDER_CATALOG[0].id, 'gemini');
  for (const id of ['gemini', 'openai', 'anthropic', 'deepseek', 'openrouter', 'groq', 'mistral', 'xai', 'together', 'fireworks', 'cerebras', 'perplexity', 'nvidia', 'cohere', 'qwen', 'ollama', 'custom']) {
    assert.ok(PROVIDER_CATALOG.some((p) => p.id === id), `Missing provider ${id}`);
  }
});

test('Settings UI uses Gemini default, inline Load models, Made-By toggle, 9 languages, and removes legacy routing/AI check controls', async () => {
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /id="routingAuto"/);
  assert.doesNotMatch(html, /id="routingSelected"/);
  assert.doesNotMatch(html, /id="aiDoctorBtn"/);
  assert.match(html, /id="setMadeByBadge"[^>]*checked/);
  assert.match(html, /<select id="hubProvider">\s*<option value="gemini" selected>/);
  assert.match(html, /class="modelInputRow"[\s\S]*id="hubModel"[\s\S]*id="hubLoadModels"/);
  for (const lang of ['en', 'vi', 'zh', 'ja', 'ko', 'es', 'fr', 'de', 'pt']) {
    assert.match(html, new RegExp(`id="langSelect"[\\s\\S]*<option value="${lang}"`), `Missing lang ${lang} in #langSelect`);
  }
});

test('Strict 3-tier language priority (prompt > UI selection > browser location) and 9 UI languages work accurately', async () => {
  assert.deepEqual(SUPPORTED_UI_LOCALES, ['en', 'vi', 'zh', 'ja', 'ko', 'es', 'fr', 'de', 'pt']);

  // Tier 1 overrides Tier 2 and Tier 3; English tech loanwords like "app" do not hijack Vietnamese
  assert.equal(detectUserLanguage('Tạo app quản lý chi tiêu cá nhân'), 'Vietnamese');
  assert.equal(detectUserLanguage('Fix bug in snake game'), 'English');
  assert.equal(detectUserLanguage('スネークゲームを作って'), 'Japanese');
  assert.equal(detectUserLanguage('请创建一个记账应用'), 'Chinese');
  assert.equal(detectUserLanguage('가계부 앱을 만들어 주세요'), 'Korean');

  assert.equal(resolveEffectiveLanguage({
    message: 'Hola quiero una app de gastos',
    selectedLocale: 'vi',
    acceptLanguage: 'en-US,en;q=0.9',
  }), 'Spanish');

  // Tier 2 overrides Tier 3 when message has neutral/ambiguous symbols or empty text
  assert.equal(resolveEffectiveLanguage({
    message: '12345 ???',
    selectedLocale: 'ja',
    acceptLanguage: 'fr-FR,fr;q=0.9',
  }), 'Japanese');

  // Tier 3 used when message is empty and no UI locale selected
  assert.equal(resolveEffectiveLanguage({
    message: '',
    selectedLocale: '',
    acceptLanguage: 'de-DE,de;q=0.9,en;q=0.8',
  }), 'German');

  assert.match(languageInstructionFor('Vietnamese'), /Generated product application UI.*Vietnamese/s);

  for (const loc of SUPPORTED_UI_LOCALES) {
    assert.ok(serverT(loc, 'done'), `Missing server translation for ${loc}`);
  }
  const clientI18n = await fs.readFile(new URL('../public/i18n.js', import.meta.url), 'utf8');
  for (const loc of SUPPORTED_UI_LOCALES) {
    assert.match(clientI18n, new RegExp(`\\b${loc}:\\s*\\{`), `Missing client dict for ${loc}`);
  }
});

test('Made-By logo badge toggle ON stamps badge and OFF strips badge', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-badge-'));
  try {
    await fs.mkdir(path.join(dir, 'public'), { recursive: true });
    await fs.writeFile(path.join(dir, 'public/index.html'), '<!doctype html><html><head><title>Test</title></head><body><h1>Hi</h1></body></html>');

    assert.equal(isMadeByEnabled({ branding: { madeByBadge: true } }), true);
    await stampMadeBy(dir, { branding: { madeByBadge: true } });
    let html = await fs.readFile(path.join(dir, 'public/index.html'), 'utf8');
    assert.match(html, /paf-made-by/);
    assert.match(html, /made-by\.png/);

    assert.equal(isMadeByEnabled({ branding: { madeByBadge: false } }), false);
    await stampMadeBy(dir, { branding: { madeByBadge: false } });
    html = await fs.readFile(path.join(dir, 'public/index.html'), 'utf8');
    assert.doesNotMatch(html, /paf-made-by/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('SoloHost 2-file generator respects defaults (empty form), auth, and custom fixedValues', async () => {
  const srcDir = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-sh-policy-'));
  try {
    await fs.writeFile(path.join(srcDir, 'package.json'), JSON.stringify({ name: 'shop-app', version: '1.0.0' }));
    await fs.writeFile(path.join(srcDir, '.env.example'), 'APP_PASSWORD=\nSHOP_NAME=Demo Shop\nCURRENCY=USD\n');
    await fs.writeFile(path.join(srcDir, 'server.js'), [
      'const port = process.env.PORT || 3000;',
      'const pass = process.env.APP_PASSWORD || "";',
      'const shop = process.env.SHOP_NAME || "Demo Shop";',
      'const currency = process.env.CURRENCY || "USD";',
    ].join('\n'));
    await fs.writeFile(path.join(srcDir, 'Dockerfile'), 'FROM node:22-alpine\nEXPOSE 3000\nCMD ["node","server.js"]\n');

    const project = { id: 'p-test', slug: 'shop-app', name: 'Shop App', port: 3000 };

    // 1) defaults -> fields: [] (no prompts)
    const defPkg = await writeSoloHostPackage({
      project,
      sourceDir: srcDir,
      image: 'ghcr.io/u/shop-app:latest',
      description: 'Shop App',
      fieldPolicy: { mode: 'defaults', fields: {}, fixedValues: {} },
    });
    const defCompose = await fs.readFile(path.join(srcDir, 'solohost/docker-compose.yml'), 'utf8');
    const defConfig = await fs.readFile(path.join(srcDir, 'solohost/config_options.yml'), 'utf8');
    assert.match(defConfig, /fields:\s*\[\]/);
    const defLint = lintPackage({ composeText: defCompose, configText: defConfig, policy: defPkg.fieldPolicy });
    assert.equal(defLint.errors.length, 0, JSON.stringify(defLint.errors));

    // 2) custom -> SHOP_NAME fixed with custom value, CURRENCY omitted, APP_PASSWORD kept
    const custPkg = await writeSoloHostPackage({
      project,
      sourceDir: srcDir,
      image: 'ghcr.io/u/shop-app:latest',
      description: 'Shop App',
      fieldPolicy: {
        mode: 'custom',
        fields: { APP_PASSWORD: 'keep', SHOP_NAME: 'fixed', CURRENCY: 'omit' },
        fixedValues: { SHOP_NAME: 'Tra Sua 123' },
      },
    });
    const custCompose = await fs.readFile(path.join(srcDir, 'solohost/docker-compose.yml'), 'utf8');
    const custConfig = await fs.readFile(path.join(srcDir, 'solohost/config_options.yml'), 'utf8');
    assert.match(custConfig, /name:\s*APP_PASSWORD/);
    assert.match(custConfig, /fixed_values:[\s\S]*name:\s*SHOP_NAME[\s\S]*value:\s*"Tra Sua 123"/);
    assert.doesNotMatch(custConfig, /name:\s*CURRENCY/);
    assert.doesNotMatch(custCompose, /CURRENCY:\s*\$\{CURRENCY\}/);
    const custLint = lintPackage({ composeText: custCompose, configText: custConfig, policy: custPkg.fieldPolicy });
    assert.equal(custLint.errors.length, 0, JSON.stringify(custLint.errors));
  } finally {
    await fs.rm(srcDir, { recursive: true, force: true });
  }
});
