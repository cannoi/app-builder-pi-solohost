import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export async function runPlaywrightE2E({
  uiUrl,
  screenshotPath = null,
  afterScreenshotPath = null,
  timeoutMs = 30000,
  browserFactory = null,
  verificationActions = null,
  strictInteraction = false,
  captureImages = false,
  skipInternetProbe = false,
} = {}) {
  const result = e2eResult({ status: 'failed', ui_url: uiUrl, test_metrics: { page_title: '', load_time_ms: 0 }, error: null });
  const started = Date.now();
  let browser = null;
  let page = null;
  const pageErrors = [];
  const consoleErrors = [];
  const failedRequests = [];
  const actionResults = [];

  try {
    const factory = browserFactory || defaultBrowserFactory;
    browser = await factory();
    page = await browser.newPage();

    if (typeof page.setViewportSize === 'function') {
      await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {});
    }

    if (typeof page.on === 'function') {
      page.on('pageerror', (err) => {
        const msg = String(err?.message || err || '').trim();
        if (msg) pageErrors.push(msg.slice(0, 300));
      });
      page.on('console', (msg) => {
        try {
          if (msg?.type?.() === 'error') {
            const txt = String(msg.text?.() || '').trim();
            if (txt && !/favicon\.ico/i.test(txt)) consoleErrors.push(txt.slice(0, 300));
          }
        } catch {}
      });
      page.on('requestfailed', (req) => {
        try {
          const url = String(req?.url?.() || '');
          if (!url || /favicon\.ico|example\.com|google\.com/i.test(url)) return;
          failedRequests.push({
            url: url.slice(0, 200),
            method: String(req?.method?.() || 'GET'),
            status: 0,
            error: String(req?.failure?.()?.errorText || 'requestfailed').slice(0, 120),
            isApi: /\/api\//i.test(url),
          });
        } catch {}
      });
      page.on('response', (res) => {
        try {
          const status = Number(res?.status?.() || 0);
          const url = String(res?.url?.() || '');
          if (status >= 400 && url && !/favicon\.ico|example\.com|google\.com/i.test(url)) {
            failedRequests.push({
              url: url.slice(0, 200),
              method: String(res?.request?.()?.method?.() || 'GET'),
              status,
              error: `HTTP ${status}`,
              isApi: /\/api\//i.test(url),
            });
          }
        } catch {}
      });
    }

    await page.goto(uiUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    if (typeof page.waitForTimeout === 'function') await page.waitForTimeout(300).catch(() => {});

    result.test_metrics.page_title = String(await page.title().catch(() => '') || '');
    result.test_metrics.load_time_ms = Date.now() - started;

    const initialMetrics = await collectDomMetrics(page);
    const beforeDataUrl = await captureScreenshot(page, screenshotPath, captureImages);

    const hasInteractiveApi = typeof page.evaluate === 'function'
      && (Array.isArray(verificationActions) && verificationActions.length > 0 || initialMetrics !== null);

    let domChanged = false;
    let canvasChanged = false;
    let urlChanged = false;
    let inputAccepted = false;
    let afterMetrics = initialMetrics;
    const beforeUrl = typeof page.url === 'function' ? String(page.url() || uiUrl) : uiUrl;

    if (hasInteractiveApi && initialMetrics && Array.isArray(verificationActions) && verificationActions.length > 0) {
      let latestMetrics = initialMetrics;
      for (const act of verificationActions.slice(0, 6)) {
        const outcome = await performVerificationAction(page, act, latestMetrics);
        actionResults.push(outcome);
        const nextMetrics = await collectDomMetrics(page);
        if (nextMetrics) {
          const delta = compareMetrics(latestMetrics, nextMetrics);
          if (delta.domChanged) domChanged = true;
          if (delta.canvasChanged) canvasChanged = true;
          outcome.changed = outcome.changed || delta.anyChanged;
          if (outcome.inputAccepted) inputAccepted = true;
          latestMetrics = nextMetrics;
          afterMetrics = nextMetrics;
        }
      }
      if (typeof page.url === 'function') {
        const nowUrl = String(page.url() || uiUrl);
        if (nowUrl && nowUrl !== beforeUrl) urlChanged = true;
      }
    }

    const afterPath = afterScreenshotPath || (screenshotPath ? deriveAfterPath(screenshotPath) : null);
    const afterDataUrl = (afterPath || captureImages)
      ? await captureScreenshot(page, afterPath, captureImages)
      : null;

    if (typeof page.evaluate === 'function' && !skipInternetProbe) {
      result.internet = await page.evaluate(async () => {
        const targets = ['https://example.com/', 'https://www.google.com/'];
        const checks = await Promise.all(targets.map(async (url) => {
          try {
            const r = await fetch(url, { method: 'HEAD', mode: 'no-cors', cache: 'no-store' });
            return { url, ok: true, status: r.type === 'opaque' ? 0 : r.status };
          } catch (e) { return { url, ok: false, error: String(e?.message || e).slice(0, 180) }; }
        }));
        return { ok: checks.some((x) => x.ok), checks };
      }).catch((e) => ({ ok: false, checks: [], error: String(e?.message || e).slice(0, 180) }));
    }

    const criticalRequests = failedRequests.filter((r) => r.status >= 500 || r.isApi || r.status === 0);
    const hasRichTelemetry = Boolean(
      typeof page.evaluate === 'function'
      || typeof page.on === 'function'
      || (Array.isArray(verificationActions) && verificationActions.length > 0)
      || captureImages
      || afterScreenshotPath
      || pageErrors.length
      || consoleErrors.length
      || failedRequests.length,
    );
    if (hasRichTelemetry) {
      result.evidence = {
        browserAvailable: true,
        loaded: true,
        pageErrors,
        consoleErrors,
        failedRequests,
        actionResults,
        initialMetrics: initialMetrics || {},
        afterMetrics: afterMetrics || initialMetrics || {},
        domChanged,
        canvasChanged,
        urlChanged,
        inputAccepted,
        screenshotPath: screenshotPath || null,
        afterScreenshotPath: afterPath || null,
        ...(beforeDataUrl ? { beforeDataUrl } : {}),
        ...(afterDataUrl ? { afterDataUrl } : {}),
      };
    }

    if (pageErrors.length > 0) {
      result.status = 'failed';
      result.error = `Uncaught JS error in browser: ${pageErrors[0]}`;
      return result;
    }
    if (consoleErrors.length > 0) {
      result.status = 'failed';
      result.error = `Console error in browser: ${consoleErrors[0]}`;
      return result;
    }
    if (criticalRequests.length > 0) {
      const r = criticalRequests[0];
      result.status = 'failed';
      result.error = `App request failed: ${r.method} ${r.url} (${r.error || r.status})`;
      return result;
    }
    if (strictInteraction && Array.isArray(verificationActions) && verificationActions.length > 0 && initialMetrics) {
      const anyChanged = domChanged || canvasChanged || urlChanged || inputAccepted;
      const anyInteractive = Number(initialMetrics.interactiveCount || 0) > 0 || Number(initialMetrics.canvasCount || 0) > 0;
      if (!anyInteractive) {
        result.status = 'failed';
        result.error = 'Interactive verification failed: no clickable buttons, inputs, or canvas controls rendered.';
        return result;
      }
      if (!anyChanged) {
        result.status = 'failed';
        result.error = 'Interactive verification failed: clicking primary controls and pressing keys produced no visible UI or canvas state change.';
        return result;
      }
    }

    result.status = 'passed';
    return result;
  } catch (err) {
    result.test_metrics.load_time_ms = Date.now() - started;
    result.error = String(err?.message || err).slice(0, 2000);
    const unavailable = /Executable doesn't exist|Failed to launch|browserType\.launch|Cannot find module 'playwright'/i.test(result.error);
    if (typeof page?.evaluate === 'function' || Array.isArray(verificationActions) && verificationActions.length > 0 || captureImages || unavailable) {
      result.evidence = {
        browserAvailable: !unavailable,
        loaded: false,
        pageErrors,
        consoleErrors,
        failedRequests,
        actionResults,
      };
    }
    return result;
  } finally {
    await page?.close?.().catch(() => {});
    await browser?.close?.().catch(() => {});
  }
}

async function collectDomMetrics(page) {
  if (typeof page?.evaluate !== 'function') return null;
  try {
    return await page.evaluate(() => {
      if (!document?.body) return null;
      const bodyText = String(document.body.innerText || '').trim();
      const buttons = [...document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], a.btn, a.button')]
        .filter((el) => {
          const r = el.getBoundingClientRect?.();
          return r && r.width > 0 && r.height > 0 && !el.disabled;
        });
      const inputs = [...document.querySelectorAll('input:not([type="hidden"]):not([type="button"]):not([type="submit"]), textarea, select')]
        .filter((el) => {
          const r = el.getBoundingClientRect?.();
          return r && r.width > 0 && r.height > 0;
        });
      const canvases = [...document.querySelectorAll('canvas')];
      let canvasSig = '';
      for (const cv of canvases.slice(0, 2)) {
        try {
          const ctx = cv.getContext?.('2d');
          if (ctx && cv.width > 0 && cv.height > 0) {
            const w = Math.min(cv.width, 64);
            const h = Math.min(cv.height, 64);
            const data = ctx.getImageData(0, 0, w, h).data;
            let acc = 0;
            for (let i = 0; i < data.length; i += 4) {
              acc = (acc * 31 + data[i] + data[i + 1] * 3 + data[i + 2] * 5 + data[i + 3]) >>> 0;
            }
            canvasSig += `${cv.width}x${cv.height}:${acc};`;
          } else {
            canvasSig += `${cv.width}x${cv.height}:non2d;`;
          }
        } catch {
          canvasSig += `${cv.width}x${cv.height}:tainted;`;
        }
      }
      const htmlSample = String(document.body.innerHTML || '');
      let htmlHash = 0;
      for (let i = 0; i < htmlSample.length; i += 1) {
        htmlHash = ((htmlHash << 5) - htmlHash + htmlSample.charCodeAt(i)) | 0;
      }
      return {
        bodyTextLen: bodyText.length,
        bodyTextSample: bodyText.slice(0, 400),
        htmlLen: htmlSample.length,
        htmlHash,
        buttonCount: buttons.length,
        inputCount: inputs.length,
        canvasCount: canvases.length,
        interactiveCount: buttons.length + inputs.length + canvases.length,
        canvasSig,
        scrollHeight: Number(document.documentElement?.scrollHeight || document.body?.scrollHeight || 0),
        viewportHeight: Number(window.innerHeight || 0),
        horizontalOverflow: Math.max(0, Number(document.documentElement?.scrollWidth || 0) - Number(window.innerWidth || 0)),
        scrollY: Number(window.scrollY || 0),
      };
    });
  } catch {
    return null;
  }
}

function compareMetrics(a, b) {
  if (!a || !b) return { domChanged: false, canvasChanged: false, anyChanged: false };
  const domChanged = a.htmlHash !== b.htmlHash || a.bodyTextSample !== b.bodyTextSample || a.buttonCount !== b.buttonCount;
  const canvasChanged = Boolean(a.canvasSig && b.canvasSig && a.canvasSig !== b.canvasSig);
  return { domChanged, canvasChanged, anyChanged: domChanged || canvasChanged };
}

async function performVerificationAction(page, action, latestMetrics) {
  const kind = String(action?.kind || 'click');
  const waitMs = Math.min(1200, Math.max(80, Number(action?.waitMs || 350)));
  const pause = () => (typeof page.waitForTimeout === 'function' ? page.waitForTimeout(waitMs).catch(() => {}) : Promise.resolve());

  if (kind === 'click') {
    const targets = Array.isArray(action.targets) ? action.targets.map((s) => String(s).toLowerCase()) : [];
    const fallbackPrimary = action.fallbackPrimaryButton !== false;
    try {
      const clicked = await page.evaluate(({ targetWords, allowFallback }) => {
        const els = [...document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], a.btn, a.button')]
          .filter((el) => {
            if (el.disabled) return false;
            const r = el.getBoundingClientRect?.();
            return r && r.width > 0 && r.height > 0;
          });
        if (!els.length) return { performed: false, target: '', note: 'no visible clickable button' };
        let picked = null;
        for (const word of targetWords) {
          picked = els.find((el) => {
            const label = `${el.innerText || el.textContent || el.value || ''} ${el.id || ''} ${el.className || ''} ${el.getAttribute('aria-label') || ''}`.toLowerCase();
            return label.includes(word);
          });
          if (picked) break;
        }
        if (!picked && allowFallback) picked = els[0];
        if (!picked) return { performed: false, target: '', note: 'matching button not found' };
        const rect = picked.getBoundingClientRect();
        const label = String(picked.innerText || picked.textContent || picked.value || picked.id || 'button').trim().slice(0, 60);
        // Dispatch full pointer/mouse + click sequence cleanly
        picked.focus?.();
        picked.click();
        return { performed: true, target: label, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
      }, { targetWords: targets, allowFallback: fallbackPrimary });

      // Also perform a real mouse click at the button's coordinates if Playwright mouse is available
      if (clicked?.performed && typeof page.mouse?.click === 'function' && Number.isFinite(clicked.x) && Number.isFinite(clicked.y)) {
        await page.mouse.click(clicked.x, clicked.y).catch(() => {});
      }
      await pause();
      return { kind, performed: Boolean(clicked?.performed), target: clicked?.target || '', changed: false, note: clicked?.note || '' };
    } catch (e) {
      return { kind, performed: false, target: '', changed: false, note: String(e?.message || e).slice(0, 120) };
    }
  }

  if (kind === 'fill_and_submit') {
    const sample = String(action.sampleText || 'Test item 123');
    const targets = Array.isArray(action.targets) ? action.targets.map((s) => String(s).toLowerCase()) : [];
    try {
      const filled = await page.evaluate(({ sampleValue, targetWords }) => {
        const inputs = [...document.querySelectorAll('input:not([type="hidden"]):not([type="button"]):not([type="submit"]), textarea')]
          .filter((el) => {
            const r = el.getBoundingClientRect?.();
            return r && r.width > 0 && r.height > 0 && !el.disabled && !el.readOnly;
          });
        let inputCount = 0;
        for (const el of inputs.slice(0, 2)) {
          const type = String(el.type || 'text').toLowerCase();
          const val = type === 'number' ? '5' : type === 'email' ? 'test@example.com' : sampleValue;
          el.focus?.();
          el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          inputCount += 1;
        }
        const btns = [...document.querySelectorAll('button, input[type="submit"], [role="button"]')]
          .filter((el) => {
            const r = el.getBoundingClientRect?.();
            return r && r.width > 0 && r.height > 0 && !el.disabled;
          });
        let submitBtn = null;
        for (const word of targetWords) {
          submitBtn = btns.find((el) => `${el.innerText || el.value || ''} ${el.id || ''}`.toLowerCase().includes(word));
          if (submitBtn) break;
        }
        if (!submitBtn) submitBtn = btns.find((el) => el.type === 'submit') || btns[0] || null;
        const label = submitBtn ? String(submitBtn.innerText || submitBtn.value || 'submit').trim().slice(0, 50) : '';
        if (submitBtn) submitBtn.click();
        return { performed: inputCount > 0 || Boolean(submitBtn), inputAccepted: inputCount > 0, target: label };
      }, { sampleValue: sample, targetWords: targets });
      await pause();
      return { kind, performed: Boolean(filled?.performed), inputAccepted: Boolean(filled?.inputAccepted), target: filled?.target || '', changed: false };
    } catch (e) {
      return { kind, performed: false, target: '', changed: false, note: String(e?.message || e).slice(0, 120) };
    }
  }

  if (kind === 'canvas_and_keys') {
    const hasCanvas = Number(latestMetrics?.canvasCount || 0) > 0;
    try {
      if (hasCanvas) {
        const coords = await page.evaluate(() => {
          const cv = document.querySelector('canvas');
          if (!cv) return null;
          const r = cv.getBoundingClientRect();
          cv.focus?.();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        });
        if (coords && typeof page.mouse?.click === 'function') {
          await page.mouse.click(coords.x, coords.y).catch(() => {});
        }
      }
      const keys = Array.isArray(action.keys) ? action.keys.slice(0, 4) : ['Space', 'ArrowRight'];
      if (typeof page.keyboard?.press === 'function') {
        for (const key of keys) {
          await page.keyboard.press(key).catch(() => {});
          if (typeof page.waitForTimeout === 'function') await page.waitForTimeout(90).catch(() => {});
        }
      }
      await pause();
      return { kind, performed: hasCanvas || keys.length > 0, target: hasCanvas ? 'canvas+keys' : 'keys', changed: false };
    } catch (e) {
      return { kind, performed: false, target: '', changed: false, note: String(e?.message || e).slice(0, 120) };
    }
  }

  if (kind === 'scroll') {
    const deltaY = Number(action.deltaY || 400);
    try {
      const scrolled = await page.evaluate((dy) => {
        const before = window.scrollY || 0;
        window.scrollBy(0, dy);
        const after = window.scrollY || 0;
        window.scrollTo(0, before);
        return { before, after, maxScroll: Math.max(0, (document.documentElement?.scrollHeight || 0) - (window.innerHeight || 0)) };
      }, deltaY);
      await pause();
      return { kind, performed: true, target: `scroll(${deltaY})`, changed: scrolled?.after !== scrolled?.before, note: `maxScroll=${scrolled?.maxScroll || 0}` };
    } catch (e) {
      return { kind, performed: false, target: 'scroll', changed: false, note: String(e?.message || e).slice(0, 120) };
    }
  }

  return { kind, performed: false, target: '', changed: false };
}

function deriveAfterPath(screenshotPath) {
  const dir = path.dirname(screenshotPath);
  const ext = path.extname(screenshotPath) || '.png';
  const base = path.basename(screenshotPath, ext);
  return path.join(dir, `${base}-after${ext}`);
}

async function captureScreenshot(page, targetPath, wantDataUrl) {
  if (typeof page?.screenshot !== 'function') return null;
  try {
    if (targetPath) {
      await fs.mkdir(path.dirname(targetPath), { recursive: true }).catch(() => {});
      const buf = await page.screenshot({ path: targetPath, fullPage: true }).catch(() => null);
      if (wantDataUrl && Buffer.isBuffer(buf) && buf.length > 0 && buf.length <= 450 * 1024) {
        return `data:image/png;base64,${buf.toString('base64')}`;
      }
      if (wantDataUrl && !Buffer.isBuffer(buf)) {
        const disk = await fs.readFile(targetPath).catch(() => null);
        if (disk && disk.length > 0 && disk.length <= 450 * 1024) {
          return `data:image/png;base64,${disk.toString('base64')}`;
        }
      }
      return null;
    }
    if (wantDataUrl) {
      const buf = await page.screenshot({ fullPage: true }).catch(() => null);
      if (Buffer.isBuffer(buf) && buf.length > 0 && buf.length <= 450 * 1024) {
        return `data:image/png;base64,${buf.toString('base64')}`;
      }
    }
  } catch {}
  return null;
}

export function e2eResult(value) {
  return {
    status: value?.status === 'passed' ? 'passed' : (value?.status === 'skipped' ? 'skipped' : 'failed'),
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
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (await existingChromiumPath()) || undefined;
  return chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
}

export async function existingChromiumPath() {
  try {
    const candidates = [
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/google-chrome',
      '/ms-playwright/chrome-headless-shell-linux64/chrome-headless-shell',
    ];
    for (const candidate of candidates) {
      try { await fs.access(candidate); return candidate; } catch {}
    }
    const cacheRoots = ['/ms-playwright', path.join(os.homedir(), '.cache', 'ms-playwright')];
    for (const root of cacheRoots) {
      const entries = await fs.readdir(root).catch(() => []);
      for (const entry of entries) {
        const nested = [
          path.join(root, entry, 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
          path.join(root, entry, 'chrome-linux64', 'chrome'),
          path.join(root, entry, 'chrome-linux', 'chrome'),
        ];
        for (const p of nested) {
          try { await fs.access(p); return p; } catch {}
        }
      }
    }
  } catch {}
  return null;
}

