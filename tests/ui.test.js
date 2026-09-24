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
  assert.match(html, /app\.js\?v=1\.4\.40/);
  assert.match(html, /styles\.css\?v=1\.4\.35/);
  assert.match(html, /No docker\.sock/);
  assert.match(html, /GitHub token/);
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
  assert.match(html, /data-action="improve"/);
  assert.match(html, /data-action="run"/);
  assert.match(html, /data-action="upgrade"/);
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

test('quick actions stay grouped without merging workflows', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const js = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(html, /Create App/);
  assert.match(html, /data-action="improve"/);
  assert.match(html, /data-action="edit"/);
  assert.match(html, /data-action="run"/);
  assert.match(html, /Upgrade App/);
  assert.match(html, /data-action="upgrade"/);
  assert.match(html, /data-action="publish"/);
  assert.match(html, /data-action="export"/);
  assert.match(html, /data-action="import"/);
  assert.match(html, /data-action="sandbox"/);
  assert.match(html, /data-action="script-github"/);
  assert.match(js, /action === 'upgrade'/);
  assert.match(js, /parseGithubInput|upgrade\/github/);
});

test('support button and Pi QR asset exist', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const js = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(html, /💛 Support/);
  assert.match(html, /GAQAZ5XLWREKQYMMN247A44PNPLAKRORZOPZNVG3CDPCSSFMEVFIYJJL/);
  assert.match(html, /0905428801/);
  assert.match(html, /support-pi-qr\.jpg/);
  assert.match(html, /img\.vietqr\.io\/image\/MB-0905428801/);
  assert.match(js, /openSupport/);
  assert.match(html, /data-action="script-run"/);
  assert.match(html, /data-action="script-github"/);
  assert.match(js, /downloadScript/);
  assert.match(js, /rollbackLast/);
  assert.equal(fs.existsSync(new URL('../public/support-pi-qr.jpg', import.meta.url)), true);
  assert.equal(fs.existsSync(new URL('../fallback/run-docker-app.ps1', import.meta.url)), true);
  assert.equal(fs.existsSync(new URL('../fallback/GitHub-ZIP-Image-Publisher-v5.0.ps1', import.meta.url)), true);
});

test('preview back bar returns to the current project', () => {
  const src = fs.readFileSync(new URL('../src/preview.js', import.meta.url), 'utf8');
  assert.match(src, /\?p=/);
  assert.match(src, /builderHome/);
  const js = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(js, /paf\.projectId/);
  assert.match(js, /savedProjectId/);
});

test('release Actions failures expose a diagnostic repair action in the chat UI', () => {
  const text = fs.readFileSync('public/app.js', 'utf8');
  assert.match(text, /github_actions_failed/);
  assert.match(text, /renderRepairAction\(result\.diagnosis\)/);
});

test('failed jobs expose a direct AI repair action in the chat UI', () => {
  const text = fs.readFileSync('public/app.js', 'utf8');
  assert.match(text, /renderRepairAction\(failure\)/);
  assert.match(text, /Diagnose & Fix/);
  assert.match(text, /Fix security issue/);
});

test('AI Provider UI uses Add/Save flow and selected model pair without legacy mode controls', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const js = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(html, /id="hubAdd"/);
  assert.match(html, /id="saveSettings"/);
  assert.match(html, /id="hubList"/);
  assert.match(html, /id="hubKey"/);
  assert.doesNotMatch(html, /id="setProvider"/);
  assert.doesNotMatch(html, />AUTO<\/option>/);
  assert.match(js, /function loadHub/);
  assert.match(js, /loadHub\(\)/);
});

test('main AI selector exposes connected providers and routes provider selection immediately', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const js = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(html, /id="aiSelect" aria-label="AI provider"/);
  assert.match(js, /renderProviderSelector/);
  assert.match(js, /preferredProvider/);
});

test('preview return preserves the active project history', () => {
  const src = fs.readFileSync(new URL('../src/preview.js', import.meta.url), 'utf8');
  const js = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(src, /\?p=\$\{id\}/);
  assert.match(js, /workHistory/);
  assert.match(js, /rememberProject\(id\)/);
});
