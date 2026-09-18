import path from 'node:path';
import { runPlaywrightE2E, e2eResult } from '../testing/playwright.js';

export async function runSandboxE2E({ podman, image, appId, previewBaseUrl = '', screenshotPath = null, timeoutSec = 180, browserFactory = null }) {
  const id = String(appId || 'app').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40) || 'app';
  const name = `paf-app-${id}`;
  let containerId = null;
  try {
    const created = await podman.createPreviewContainer({ image, name });
    containerId = created.Id || created.id;
    if (!containerId) throw new Error('Podman did not return a preview container ID.');
    await podman.startContainer(containerId);
    const deadline = Date.now() + Math.min(timeoutSec, 600) * 1000;
    let port = null;
    while (Date.now() < deadline) {
      const info = await podman.inspectContainer(containerId).catch(() => null);
      port = hostPort(info);
      if (port) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
          if (response.ok) break;
        } catch {}
      }
      await new Promise((resolve) => setTimeout(resolve, 900));
    }
    if (!port) return e2eResult({ status: 'failed', ui_url: publicUrl(previewBaseUrl, id), test_metrics: { page_title: '', load_time_ms: 0 }, error: 'Preview port was not published by Podman.' });
    const localUrl = `http://127.0.0.1:${port}`;
    const tested = await runPlaywrightE2E({ uiUrl: localUrl, screenshotPath: screenshotPath || path.join('/tmp', `${id}-preview.png`), timeoutMs: Math.min(timeoutSec * 1000, 60000), browserFactory });
    return e2eResult({ ...tested, ui_url: publicUrl(previewBaseUrl, id) });
  } catch (err) {
    return e2eResult({ status: 'failed', ui_url: publicUrl(previewBaseUrl, id), test_metrics: { page_title: '', load_time_ms: 0 }, error: String(err?.message || err).slice(0, 2000) });
  } finally {
    if (containerId) {
      await podman.stopContainer(containerId).catch(() => {});
      await podman.removeContainer(containerId).catch(() => {});
    }
  }
}

function hostPort(info) {
  const values = info?.NetworkSettings?.Ports?.['8080/tcp'] || info?.HostConfig?.PortBindings?.['8080/tcp'] || [];
  return Number(values[0]?.HostPort || 0) || null;
}

function publicUrl(base, id) {
  const root = String(base || '').replace(/\/$/, '');
  return root ? `${root}/preview-${encodeURIComponent(id)}` : `/preview/${encodeURIComponent(id)}/`;
}
