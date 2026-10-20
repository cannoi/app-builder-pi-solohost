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
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(html, new RegExp('app\\.js\\?v=' + pkg.version.replace(/\\./g, '\\.')));
  assert.match(html, new RegExp('styles\\.css\\?v=' + pkg.version.replace(/\\./g, '\\.')));
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
  assert.match(html, /moreBtn|moreMenu|data-more|sendBtn/);
  assert.match(html, /moreBtn|moreMenu|data-more|sendBtn/);
  assert.match(html, /moreBtn|moreMenu|data-more|sendBtn/);
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
  // UI_SIMPLE: one chat + more menu instead of quickGroups
  assert.match(html, /id=\"moreBtn\"/);
  assert.match(html, /id=\"moreMenu\"/);
  assert.match(html, /data-ui-simple/);
  assert.match(js, /parseGithubInput|upgrade\/github/);
  assert.match(js, /UI_SIMPLE|moreMenu|data-more/);
});

test('support button and Pi QR asset exist', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const js = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(html, /data-more=\"support\"|openSupport|Support/);
  assert.match(js, /openSupport/);
  assert.match(html, /moreBtn|moreMenu/);
  assert.match(js, /downloadScript/);
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
  assert.match(html, /id="hubLoadModels"/);
  assert.doesNotMatch(html, /data-tab="settings"/);
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

test('AI Advisor and duplicate Settings activity log are removed; unified logs remain in AI Panel', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const panel = fs.readFileSync(new URL('../public/ai-panel.js', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /advisorRun|advisorScope|runAdvisorFromSettings|loadActivityLog/);
  assert.match(panel, /api\/activity\/unified/);
  assert.doesNotMatch(html, /id=\"logsClear\"/);
});

test('settings sheet remains scrollable so fields are not clipped', () => {
  const css = fs.readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(css, /#settings \.sheet\{[^}]*overflow:\s*auto/);
  assert.doesNotMatch(css, /max-height:740px\)\{#settings \.compactInfo\{display:none/);
});

test('preview chrome explains limited preview and real-test options', () => {
  const js = fs.readFileSync(new URL('../src/preview.js', import.meta.url), 'utf8');
  assert.match(js, /Limited preview/);
  assert.match(js, /Run ZIP/);
  assert.match(js, /Unlisted/);
});

test('chat compacting collapses repeated GHCR smoke errors', () => {
  const js = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(js, /function compactNotice/);
  assert.match(js, /shouldSkipNotice/);
});

test('Upgrade UI resumes saved work instead of presenting an approval gate', () => {
  const js = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(js, /Continue Upgrade/);
  assert.match(js, /upgrade\/resume/);
  const start = js.indexOf('function renderUpgradePlan');
  const end = js.indexOf('async function startDiagnose', start);
  const block = js.slice(start, end);
  assert.doesNotMatch(block, /Apply high-risk upgrade/);
  assert.doesNotMatch(block, /Apply Upgrade/);
});
