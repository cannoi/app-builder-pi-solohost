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
