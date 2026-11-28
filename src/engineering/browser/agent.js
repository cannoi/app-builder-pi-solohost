/**
 * Browser Agent v2 (v1.10.0, M3) — real Chromium via Playwright.
 *
 * One browser, one context per viewport (desktop 1280×800, mobile 390×844 isMobile+hasTouch).
 * Collects console errors, page errors, failed requests, HTTP ≥ 400 (same-origin vs third-party) and dialogs;
 * visits "/" + up to 8 same-origin routes/links; clicks ≤ 15 visible, enabled, non-destructive controls;
 * fills forms with synthetic data and submits same-origin only; checks mobile overflow, tap targets,
 * empty body, stuck spinner and basic accessibility. The outbound-Internet probe is reported separately and
 * never changes the app verdict. No Chromium ⇒ NOT_AVAILABLE (never a fake PASS).
 * `browserFactory` exists only to unit-test the collectors — it is not QA proof.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { STATUS } from '../validation/status.js';
import { looksLikeSecret } from '../../utils/mask.js';
import { redactText } from '../redact.js';

const VIEWPORTS = {
  desktop: { viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false },
  mobile: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
};
const DESTRUCTIVE = /(delete|remove|xóa|xoá|destroy|logout|log out|sign out|đăng xuất|pay|payment|checkout|thanh toán|purchase|buy now|reset|clear all|wipe|drop|unsubscribe|cancel subscription)/i;

function fileExists(p) { try { return Boolean(p) && fs.statSync(p).isFile(); } catch { return false; } }

function scanBrowsersPath() {
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(os.homedir(), '.cache', 'ms-playwright'), '/ms-playwright', '/opt/ms-playwright'].filter(Boolean);
  for (const root of roots) {
    let dirs = [];
    try { dirs = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse(); } catch { continue; }
    for (const d of dirs) {
      for (const rel of ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        const p = path.join(root, d, rel);
        if (fileExists(p)) return p;
      }
    }
  }
  return null;
}

/** Returns an executable path that really exists, or null. */
export async function detectChromium() {
  for (const p of [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, '/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable']) {
    if (fileExists(p)) return p;
  }
  try {
    const { chromium } = await import('playwright');
    const p = chromium?.executablePath?.();
    if (fileExists(p)) return p;
  } catch { /* playwright not installed */ }
  return scanBrowsersPath();
}

function sameOrigin(url, base) {
  try { return new URL(url).origin === new URL(base).origin; } catch { return false; }
}

async function probeInternet(timeoutMs = 4000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch('https://www.gstatic.com/generate_204', { signal: ac.signal });
    return { status: r.status === 204 || r.ok ? STATUS.PASS : STATUS.WARNING, httpStatus: r.status };
  } catch (err) {
    return { status: STATUS.NOT_AVAILABLE, error: String(err.cause?.code || err.message || err).slice(0, 120) };
  } finally { clearTimeout(t); }
}

// ------------------------------------------------------------- in-page checks (serialized to the browser)
function pageChecks() {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) !== 0;
  };
  const sel = (el) => el.id ? `#${el.id}` : `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : ''}`;
  const name = (el) => (el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.value || '').trim();
  const doc = document.documentElement;
  const h1 = [...document.querySelectorAll('h1')].filter(vis).length;
  const imgsNoAlt = [...document.querySelectorAll('img')].filter((i) => !i.hasAttribute('alt')).length;
  const inputs = [...document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea')].filter(vis);
  const unlabeled = inputs.filter((i) => !(i.id && document.querySelector(`label[for="${CSS.escape(i.id)}"]`)) && !i.closest('label') && !i.getAttribute('aria-label') && !i.getAttribute('aria-labelledby') && !i.getAttribute('title')).map(sel).slice(0, 8);
  const buttons = [...document.querySelectorAll('button, [role=button], input[type=submit], input[type=button]')].filter(vis);
  const unnamedButtons = buttons.filter((b) => !name(b)).map(sel).slice(0, 8);
  const tappables = [...document.querySelectorAll('a[href], button, input, select, textarea, [role=button]')].filter(vis);
  const smallTargets = tappables.filter((el) => { const r = el.getBoundingClientRect(); return (r.width < 32 || r.height < 32) && !(el.tagName === 'INPUT' && ['checkbox', 'radio'].includes(el.type)); }).map(sel).slice(0, 10);
  const text = (document.body?.innerText || '').trim();
  const spinners = [...document.querySelectorAll('[class*=spinner], [class*=loader], [class*=loading], [aria-busy=true]')].filter(vis).length;
  const emptyEls = [...document.querySelectorAll('[class*=empty], [data-empty], [id*=empty], .empty-state, .empty')].filter(vis);
  const emptyTextRe = /\b(no\s+(?:items|records|tasks|orders|notes|data|results|entries|products|posts|messages|files)|nothing\s+(?:here\s+)?yet|empty(?:\s+state|\s+list|\s+cart)?|get\s+started|add\s+(?:your\s+)?first)\b|chưa có|danh sách trống|giỏ hàng trống|trống/i;
  const emptyStateVisible = emptyEls.length > 0 || emptyTextRe.test(text);
  return {
    lang: doc.getAttribute('lang') || '',
    title: document.title || '',
    h1,
    imgsNoAlt,
    unlabeled,
    unnamedButtons,
    viewportMeta: Boolean(document.querySelector('meta[name=viewport]')),
    overflowX: doc.scrollWidth > window.innerWidth + 1,
    scrollWidth: doc.scrollWidth,
    innerWidth: window.innerWidth,
    smallTargets,
    smallTargetCount: smallTargets.length,
    bodyTextLength: text.length,
    hasMedia: Boolean(document.querySelector('img, canvas, svg, video')),
    emptyStateVisible,
    spinners,
    loadingText: /^(loading|đang tải)\b/i.test(text),
    links: [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')).filter(Boolean).slice(0, 60),
  };
}

function a11yFindings(c, viewportName) {
  const out = [];
  const w = (code, message) => out.push({ severity: 'warning', code, viewport: viewportName, message });
  if (!c.lang) w('A11Y_HTML_LANG', '<html> has no lang attribute');
  if (!c.title.trim()) w('A11Y_TITLE', 'page has no <title>');
  if (c.h1 !== 1) w('A11Y_H1', `page has ${c.h1} visible <h1> (expected exactly 1)`);
  if (c.imgsNoAlt) w('A11Y_IMG_ALT', `${c.imgsNoAlt} image(s) without alt`);
  if (c.unlabeled.length) w('A11Y_LABEL', `form field(s) without label: ${c.unlabeled.join(', ')}`);
  if (c.unnamedButtons.length) w('A11Y_BUTTON_NAME', `button(s) without accessible name: ${c.unnamedButtons.join(', ')}`);
  if (!c.viewportMeta) w('A11Y_VIEWPORT_META', 'no <meta name="viewport">');
  return out;
}

async function domSignature(page) {
  return page.evaluate(() => ({ url: location.href, len: document.body ? document.body.innerHTML.length : 0, text: (document.body?.innerText || '').length })).catch(() => ({ url: '', len: 0, text: 0 }));
}

async function interact(page, baseUrl, { maxClicks = 15, apiHits }) {
  const results = [];
  const handles = await page.$$('button, [role=button], input[type=button]');
  let clicks = 0;
  for (const h of handles) {
    if (clicks >= maxClicks) break;
    const info = await h.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return {
        text: (el.getAttribute('aria-label') || el.innerText || el.value || '').trim().slice(0, 60),
        visible: r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none',
        disabled: el.disabled || el.getAttribute('aria-disabled') === 'true',
        inForm: Boolean(el.closest('form')) && (el.type === 'submit' || !el.type || el.getAttribute('type') === null),
      };
    }).catch(() => null);
    if (!info || !info.visible || info.disabled || info.inForm || DESTRUCTIVE.test(info.text)) continue;
    clicks += 1;
    const before = await domSignature(page);
    const hitsBefore = apiHits.length;
    let error = null;
    try { await h.click({ timeout: 2000 }); } catch (err) { error = String(err.message || err).split('\n')[0].slice(0, 160); }
    await page.waitForTimeout(350);
    const after = await domSignature(page);
    if (!sameOrigin(after.url, baseUrl)) { await page.goBack({ timeout: 5000 }).catch(() => {}); }
    const changed = after.url !== before.url || after.len !== before.len || apiHits.length > hitsBefore;
    results.push({ control: info.text || '(unnamed)', changed, apiCalls: apiHits.length - hitsBefore, error });
  }
  return results;
}

async function fillAndSubmitForms(page, baseUrl, apiHits, maxForms = 3) {
  const out = [];
  const forms = await page.$$('form');
  for (const form of forms.slice(0, maxForms)) {
    const meta = await form.evaluate((f) => ({ action: f.getAttribute('action') || '', method: (f.getAttribute('method') || 'get').toLowerCase(), text: (f.innerText || '').slice(0, 80) })).catch(() => null);
    if (!meta) continue;
    const actionUrl = meta.action ? new URL(meta.action, page.url()).toString() : page.url();
    if (!sameOrigin(actionUrl, baseUrl)) { out.push({ form: meta.text, skipped: 'third-party action' }); continue; }
    if (DESTRUCTIVE.test(meta.text) || DESTRUCTIVE.test(meta.action)) { out.push({ form: meta.text, skipped: 'destructive' }); continue; }
    const fields = await form.$$('input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select');
    for (const f of fields) {
      const kind = await f.evaluate((el) => ({ tag: el.tagName.toLowerCase(), type: (el.getAttribute('type') || 'text').toLowerCase(), name: el.name || el.id || '' })).catch(() => null);
      if (!kind) continue;
      try {
        if (kind.tag === 'select') { const opts = await f.$$eval('option', (o) => o.map((x) => x.value)); if (opts.length) await f.selectOption(opts[Math.min(1, opts.length - 1)]); }
        else if (kind.type === 'checkbox' || kind.type === 'radio') await f.check({ timeout: 1000 });
        else if (kind.type === 'email') await f.fill('qa@example.com', { timeout: 1000 });
        else if (kind.type === 'number' || kind.type === 'range') await f.fill('3', { timeout: 1000 });
        else if (kind.type === 'date') await f.fill('2026-01-15', { timeout: 1000 });
        else if (kind.type === 'url') await f.fill('https://example.com', { timeout: 1000 });
        else if (kind.type === 'tel') await f.fill('0900000000', { timeout: 1000 });
        else if (kind.type === 'password') await f.fill('QaTest#2026', { timeout: 1000 });
        else if (kind.type === 'file' || kind.type === 'color') { /* skip */ }
        else await f.fill(kind.tag === 'textarea' ? 'Hello from App Builder QA' : 'QA test item', { timeout: 1000 });
      } catch { /* field not fillable */ }
    }
    const before = await domSignature(page);
    const hitsBefore = apiHits.length;
    let error = null;
    try {
      await form.evaluate((f) => (typeof f.requestSubmit === 'function' ? f.requestSubmit() : f.submit()));
      await page.waitForLoadState('domcontentloaded', { timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(500);
    } catch (err) { error = String(err.message || err).split('\n')[0].slice(0, 160); }
    const after = await domSignature(page);
    const okApi = apiHits.slice(hitsBefore).filter((h) => h.status >= 200 && h.status < 300).length;
    out.push({ form: meta.text || '(form)', changed: after.url !== before.url || after.len !== before.len || apiHits.length > hitsBefore, apiCalls: apiHits.length - hitsBefore, apiOk: okApi, error });
    if (!sameOrigin(after.url, baseUrl)) await page.goBack({ timeout: 5000 }).catch(() => {});
  }
  return out;
}

async function runViewport(browser, name, { baseUrl, routes, artifactsDir, timeoutMs, interactions }) {
  const spec = VIEWPORTS[name];
  const context = await browser.newContext({ ...spec, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  const httpErrors = [];
  const dialogs = [];
  const apiHits = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(redactText(msg.text()).slice(0, 300)); });
  page.on('pageerror', (err) => pageErrors.push(redactText(String(err.message || err)).slice(0, 300)));
  page.on('requestfailed', (req) => failedRequests.push({ url: redactText(req.url()).slice(0, 200), error: req.failure()?.errorText || 'failed', sameOrigin: sameOrigin(req.url(), baseUrl) }));
  page.on('response', (res) => {
    const u = res.url();
    const so = sameOrigin(u, baseUrl);
    if (res.status() >= 400) httpErrors.push({ url: redactText(u).slice(0, 200), status: res.status(), sameOrigin: so });
    if (so && /\/api\//.test(new URL(u).pathname) && ['fetch', 'xhr'].includes(res.request().resourceType())) apiHits.push({ path: new URL(u).pathname, status: res.status() });
  });
  page.on('dialog', async (d) => { dialogs.push({ type: d.type(), message: redactText(d.message()).slice(0, 160) }); await d.dismiss().catch(() => {}); });

  const visits = [];
  const screenshots = [];
  const findings = [];
  let checks = null;
  try {
    const first = await page.goto(baseUrl, { timeout: Math.min(timeoutMs, 45_000), waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
    visits.push({ path: '/', status: first?.status() || null });
    if (first && first.status() >= 400) findings.push({ severity: 'error', code: 'HTTP_ERROR', viewport: name, message: `GET / → ${first.status()}` });
    checks = await page.evaluate(pageChecks);
    await page.waitForTimeout(name === 'mobile' ? 300 : 0);
    // stuck spinner: still loading after ~3 s
    if (checks.spinners || checks.loadingText) {
      await page.waitForTimeout(3000);
      const again = await page.evaluate(pageChecks);
      if (again.spinners || again.loadingText) findings.push({ severity: 'warning', code: 'STUCK_SPINNER', viewport: name, message: 'a loading indicator is still visible after 3 s' });
      checks = again;
    }
    if (checks.bodyTextLength < 5 && !checks.hasMedia) findings.push({ severity: 'error', code: 'EMPTY_BODY', viewport: name, message: 'the page renders no visible content' });
    findings.push(...a11yFindings(checks, name));
    if (name === 'mobile') {
      if (checks.overflowX) findings.push({ severity: 'warning', code: 'MOBILE_OVERFLOW', viewport: name, message: `horizontal overflow at 390 px (scrollWidth ${checks.scrollWidth})` });
      if (checks.smallTargetCount) findings.push({ severity: 'warning', code: 'TAP_TARGET', viewport: name, message: `${checks.smallTargetCount} tap target(s) smaller than 32 px: ${checks.smallTargets.slice(0, 4).join(', ')}` });
    }
    if (artifactsDir) {
      const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
      if (looksLikeSecret(text)) findings.push({ severity: 'warning', code: 'SCREENSHOT_SKIPPED_SECRET', viewport: name, message: 'screenshot skipped: page shows a secret-looking value' });
      else {
        await fsp.mkdir(artifactsDir, { recursive: true });
        const file = path.join(artifactsDir, `${name}-home.png`);
        await page.screenshot({ path: file }).catch(() => {});
        screenshots.push(file);
      }
    }
    // same-origin routes: declared routes + discovered links
    const discovered = (checks.links || []).map((h) => { try { const u = new URL(h, baseUrl); return sameOrigin(u.toString(), baseUrl) ? u.pathname : null; } catch { return null; } }).filter(Boolean);
    const extra = [...new Set([...(routes || []), ...discovered])].filter((p) => p !== '/' && !DESTRUCTIVE.test(p) && !p.includes(':') && !/^\/(api|health|healthz|ready|live)(\/|$)/.test(p) && !/\.(png|jpe?g|gif|svg|ico|css|js|json|txt|zip|pdf)$/i.test(p)).slice(0, 8);
    for (const p of extra) {
      try {
        const r = await page.goto(new URL(p, baseUrl).toString(), { timeout: 15_000, waitUntil: 'domcontentloaded' });
        visits.push({ path: p, status: r?.status() || null });
        if (r && r.status() >= 400) findings.push({ severity: r.status() >= 500 ? 'error' : 'warning', code: 'ROUTE_HTTP_ERROR', viewport: name, message: `GET ${p} → ${r.status()}` });
      } catch (err) {
        visits.push({ path: p, error: String(err.message || err).split('\n')[0].slice(0, 160) });
        findings.push({ severity: 'error', code: 'ROUTE_NAV_ERROR', viewport: name, message: `navigating to ${p} failed: ${String(err.message || err).split('\n')[0].slice(0, 120)}` });
      }
    }
    let clickResults = [];
    let formResults = [];
    if (interactions) {
      await page.goto(baseUrl, { timeout: 15_000, waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => {});
      clickResults = await interact(page, baseUrl, { maxClicks: 15, apiHits });
      formResults = await fillAndSubmitForms(page, baseUrl, apiHits);
      const dead = clickResults.filter((c) => !c.changed && !c.error);
      if (clickResults.length && dead.length === clickResults.length) findings.push({ severity: 'warning', code: 'NO_FEEDBACK', viewport: name, message: `${dead.length} control(s) clicked with no visible change or API call` });
      for (const f of formResults) if (f.apiCalls && !f.apiOk) findings.push({ severity: 'error', code: 'FORM_API_ERROR', viewport: name, message: `submitting "${f.form.slice(0, 40)}" called the API but got no 2xx` });
    }
    // Browsers request /favicon.ico on their own; a missing favicon is not an app defect.
    const isFavicon = (u) => /\/favicon\.ico(\?|$)/.test(u);
    const soHttp = httpErrors.filter((e) => e.sameOrigin && !isFavicon(e.url));
    // "Failed to load resource" console lines duplicate network events (and include the browser's own favicon
    // request, which is not always visible as a page response) — judge resources from network events only.
    for (let i = consoleErrors.length - 1; i >= 0; i -= 1) if (/^Failed to load resource/i.test(consoleErrors[i])) consoleErrors.splice(i, 1);
    // 502/504 from a same-origin proxy endpoint means the upstream/Internet failed, not the app itself.
    const upstream = soHttp.filter((e) => e.status === 502 || e.status === 504);
    for (const e of upstream.slice(0, 4)) findings.push({ severity: 'warning', code: 'UPSTREAM_GATEWAY', viewport: name, message: `${e.status} ${e.url} (upstream/Internet dependent — not counted as an app failure)` });
    const soFailed = failedRequests.filter((e) => e.sameOrigin && !/ERR_ABORTED/.test(e.error) && !isFavicon(e.url));
    for (const e of soHttp.filter((x) => (x.status >= 500 && x.status !== 502 && x.status !== 504) || x.status === 404).slice(0, 6)) findings.push({ severity: 'error', code: 'SAME_ORIGIN_HTTP', viewport: name, message: `${e.status} ${e.url}` });
    for (const e of soFailed.slice(0, 6)) findings.push({ severity: 'error', code: 'REQUEST_FAILED', viewport: name, message: `${e.error} ${e.url}` });
    for (const e of pageErrors.slice(0, 6)) findings.push({ severity: 'error', code: 'PAGE_ERROR', viewport: name, message: e });
    for (const e of consoleErrors.slice(0, 6)) findings.push({ severity: /Failed to load resource/i.test(e) && !soHttp.length ? 'warning' : 'error', code: 'CONSOLE_ERROR', viewport: name, message: e });
    const thirdParty = [...httpErrors, ...failedRequests].filter((e) => !e.sameOrigin);
    if (thirdParty.length) findings.push({ severity: 'warning', code: 'THIRD_PARTY', viewport: name, message: `${thirdParty.length} third-party request(s) failed (not counted against the app)` });
    return { viewport: name, visits, checks, consoleErrors, pageErrors, failedRequests, httpErrors, dialogs, interactions: { clicks: clickResults, forms: formResults }, apiHits, screenshots, findings };
  } catch (err) {
    findings.push({ severity: 'error', code: 'NAVIGATION_FAILED', viewport: name, message: String(err.message || err).split('\n')[0].slice(0, 200) });
    return { viewport: name, visits, checks, consoleErrors, pageErrors, failedRequests, httpErrors, dialogs, interactions: null, apiHits, screenshots, findings };
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * @param {{ baseUrl: string, routes?: string[], viewports?: string[], mobile?: boolean, timeoutMs?: number,
 *   artifactsDir?: string, interactions?: boolean, probeInternet?: boolean, browserFactory?: function }} opts
 */
export async function runBrowserAgent(opts = {}) {
  const { baseUrl, routes = ['/'], timeoutMs = 90_000, browserFactory = null, mobile = false, artifactsDir = null, interactions = true, signal = null } = opts;
  const viewports = Array.isArray(opts.viewports) && opts.viewports.length ? opts.viewports.filter((v) => VIEWPORTS[v]) : [mobile ? 'mobile' : 'desktop'];
  if (!baseUrl) return { ok: false, status: STATUS.NOT_AVAILABLE, error: 'baseUrl required' };
  if (signal?.aborted) return { ok: false, status: STATUS.NOT_TESTED, error: 'cancelled', data: { reason: 'CANCELLED', environment: { internet: { status: STATUS.NOT_TESTED } } } };
  const environment = { internet: opts.probeInternet ? await probeInternet() : { status: STATUS.NOT_TESTED } };

  // Unit-testable collector path (NOT proof of real Chromium QA)
  if (browserFactory) {
    const page = await browserFactory();
    const consoleErrors = [];
    const findings = [];
    if (page.on) page.on('console', (msg) => { if (msg.type?.() === 'error') consoleErrors.push(String(msg.text?.() || msg)); });
    try {
      if (page.goto) await page.goto(baseUrl, { timeout: Math.min(timeoutMs, 30_000) });
      const title = page.title ? await page.title() : '';
      if (!title) findings.push({ severity: 'warning', code: 'A11Y_TITLE', message: 'empty title' });
    } catch (err) {
      return { ok: false, status: STATUS.FAIL, data: { error: String(err.message || err), consoleErrors, findings, via: 'browserFactory' } };
    }
    return { ok: consoleErrors.length === 0, status: consoleErrors.length ? STATUS.FAIL : STATUS.PASS, data: { consoleErrors, findings, routesChecked: routes.slice(0, 8), environment, via: 'browserFactory' } };
  }

  const executable = await detectChromium();
  if (!executable) {
    return { ok: true, status: STATUS.NOT_AVAILABLE, error: 'Chromium not installed — browser QA skipped', data: { reason: 'NOT_AVAILABLE', message: 'Chromium not installed — browser QA skipped', environment } };
  }
  let chromium;
  try { ({ chromium } = await import('playwright')); } catch (err) {
    return { ok: true, status: STATUS.NOT_AVAILABLE, error: 'playwright module unavailable', data: { reason: 'NOT_AVAILABLE', message: String(err.message || err).slice(0, 200), environment } };
  }
  if (signal?.aborted) return { ok: false, status: STATUS.NOT_TESTED, error: 'cancelled', data: { reason: 'CANCELLED', environment } };
  let browser;
  try {
    browser = await chromium.launch({ executablePath: executable, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  } catch (err) {
    return { ok: true, status: STATUS.NOT_AVAILABLE, error: `Chromium could not start: ${String(err.message || err).split('\n')[0].slice(0, 200)}`, data: { reason: 'NOT_AVAILABLE', environment } };
  }
  const onAbort = () => { browser?.close?.().catch(() => {}); };
  signal?.addEventListener?.('abort', onAbort, { once: true });
  const started = Date.now();
  try {
    const results = {};
    for (const v of viewports) {
      if (signal?.aborted) break;
      results[v] = await runViewport(browser, v, { baseUrl, routes, artifactsDir, timeoutMs, interactions });
    }
    const findings = Object.values(results).flatMap((r) => r.findings);
    const errors = findings.filter((f) => f.severity === 'error');
    const warnings = findings.filter((f) => f.severity === 'warning' && f.code !== 'THIRD_PARTY');
    const status = signal?.aborted ? STATUS.NOT_TESTED : (errors.length ? STATUS.FAIL : warnings.length ? STATUS.WARNING : STATUS.PASS);
    return {
      ok: !signal?.aborted && !errors.length,
      status,
      error: signal?.aborted ? 'cancelled' : (errors.length ? errors.slice(0, 3).map((e) => `[${e.viewport}] ${e.message}`).join('; ') : undefined),
      data: {
        executable: path.basename(executable),
        viewports: results,
        findings: findings.slice(0, 60),
        consoleErrors: Object.values(results).flatMap((r) => r.consoleErrors).slice(0, 20),
        pageErrors: Object.values(results).flatMap((r) => r.pageErrors).slice(0, 20),
        failedRequests: Object.values(results).flatMap((r) => r.failedRequests).slice(0, 20),
        routesChecked: [...new Set(Object.values(results).flatMap((r) => r.visits.map((v) => v.path)))],
        screenshots: Object.values(results).flatMap((r) => r.screenshots),
        environment,
        durationMs: Date.now() - started,
      },
    };
  } finally {
    signal?.removeEventListener?.('abort', onAbort);
    await browser.close().catch(() => {});
  }
}
