export async function runPlaywrightE2E({ uiUrl, screenshotPath = null, timeoutMs = 30000, browserFactory = null }) {
  const result = e2eResult({ status: 'failed', ui_url: uiUrl, test_metrics: { page_title: '', load_time_ms: 0 }, error: null });
  const started = Date.now();
  let browser = null;
  let page = null;
  try {
    const factory = browserFactory || defaultBrowserFactory;
    browser = await factory();
    page = await browser.newPage();
    await page.goto(uiUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    result.test_metrics.page_title = String(await page.title().catch(() => '') || '');
    result.test_metrics.load_time_ms = Date.now() - started;
    if (screenshotPath) await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    // A page-load success is not proof that the preview browser has Internet access.
    // Keep this deterministic probe small and separate from the app's own proxy.
    if (typeof page.evaluate === 'function') result.internet = await page.evaluate(async () => {
      const targets = ['https://example.com/', 'https://www.google.com/'];
      const checks = await Promise.all(targets.map(async (url) => {
        try {
          const r = await fetch(url, { method: 'HEAD', mode: 'no-cors', cache: 'no-store' });
          return { url, ok: true, status: r.type === 'opaque' ? 0 : r.status };
        } catch (e) { return { url, ok: false, error: String(e?.message || e).slice(0, 180) }; }
      }));
      return { ok: checks.some((x) => x.ok), checks };
    }).catch((e) => ({ ok: false, checks: [], error: String(e?.message || e).slice(0, 180) }));
    result.status = 'passed';
    return result;
  } catch (err) {
    result.test_metrics.load_time_ms = Date.now() - started;
    result.error = String(err?.message || err).slice(0, 2000);
    return result;
  } finally {
    await page?.close?.().catch(() => {});
    await browser?.close?.().catch(() => {});
  }
}

export function e2eResult(value) {
  return {
    status: value?.status === 'passed' ? 'passed' : 'failed',
    ui_url: String(value?.ui_url || ''),
    test_metrics: {
      page_title: String(value?.test_metrics?.page_title || ''),
      load_time_ms: Number(value?.test_metrics?.load_time_ms || 0),
    },
    error: value?.error == null ? null : String(value.error),
    ...(value?.internet ? { internet: { ok: value.internet.ok === true, checks: Array.isArray(value.internet.checks) ? value.internet.checks : [], error: value.internet.error || null } } : {}),
  };
}

async function defaultBrowserFactory() {
  const { chromium } = await import('playwright');
  return chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (await existingChromiumPath()) || undefined });
}

async function existingChromiumPath() {
  try {
    const { access } = await import('node:fs/promises');
    const candidates = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
    for (const candidate of candidates) {
      try { await access(candidate); return candidate; } catch {}
    }
  } catch {}
  return null;
}
