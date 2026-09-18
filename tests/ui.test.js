import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('settings modal can be hidden and all setup buttons exist', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.modal/);
  assert.match(css, /\.modal\[hidden\]\{display:none!important\}/);
  assert.match(html, /id="settings"[^>]*hidden/);
  assert.match(html, /id="saveSettings"/);
  assert.match(html, /App Builder/);
  const js = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(js, /closeSettings/);
  assert.match(js, /FormData/);
});

test('single chat builder UI and attachment controls are present', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const js = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(html, /id="chat"/);
  assert.match(html, /id="attachBtn"/);
  assert.match(html, /data-action="build"/);
  assert.match(html, /data-action="run"/);
  assert.match(html, /data-action="run"/);
  assert.match(js, /FormData/);
  assert.match(js, /builder_chat|\/api\/chat/);
  assert.match(js, /state\.busy/);
  assert.match(js, /previewPath/);
  assert.match(html, /id="jumpDown"/);
  assert.match(html, /id="aiSelect"/);
  assert.match(html, /class="hero"/);
  assert.match(html, /id="workPill"/);
});


test('old multi-panel workflow is removed from the main screen', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /id=\"projectView\"/);
  assert.doesNotMatch(html, /id=\"pActions\"/);
  assert.doesNotMatch(html, /id=\"advPanel\"/);
});


test('Native preview requires no Docker access or blocking access modal', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const js = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /id="dockerAccess"/);
  assert.doesNotMatch(html, /I understand/);
  assert.doesNotMatch(js, /needsDockerAccess|showDockerAccess|closeDocker|dockerDone/);
});

test('Preview results provide a direct test link', () => {
  const js = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(js, /Open the test UI/);
  assert.match(js, /previewPath/);
});


test('branding uses the full uploaded logo and non-cropped banner', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  const badge = fs.readFileSync(new URL('../src/projects/badge.js', import.meta.url), 'utf8');
  assert.match(html, /src="\/app-logo\.jpg"/);
  assert.match(css, /\.hero img\{[^}]*object-fit:contain/);
  assert.match(badge, /made-by\.png/);
  assert.match(badge, /opacity:\.5/);
  assert.match(badge, /background:transparent/);
});

test('HTTP server recognizes uploaded image assets as image content', async () => {
  const source = fs.readFileSync(new URL('../src/http.js', import.meta.url), 'utf8');
  assert.match(source, /['"]\.jpg['"]\s*:\s*['"]image\/jpeg/);
  assert.match(source, /['"]\.jpeg['"]\s*:\s*['"]image\/jpeg/);
  assert.match(source, /['"]\.webp['"]\s*:\s*['"]image\/webp/);
});

test('Check action posts to analyze', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const js = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const routes = fs.readFileSync(new URL('../src/api/routes.js', import.meta.url), 'utf8');
  assert.match(html, /data-action="analyze"/);
  assert.match(js, /action === 'analyze'|\/analyze/);
  assert.match(routes, /analyze/);
});
