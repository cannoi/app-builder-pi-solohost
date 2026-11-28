import path from 'node:path';
import { runPlaywrightE2E, e2eResult } from '../testing/playwright.js';

export async function runSandboxE2E({ podman, image, appId, previewBaseUrl = '', screenshotPath = null, timeoutSec = 180, browserFactory = null, existingContainer = null, keepRunning = false }) {
  const id = String(appId || 'app').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40) || 'app';
  const name = `paf-app-${id}`;
  let containerId = existingContainer?.id || null;
  let createdHere = false;
  try {
    if (!containerId) {
      const created = await podman.createPreviewContainer({ image, name });
      containerId = created.Id || created.id;
      if (!containerId) throw new Error('Container Sandbox did not return a preview container ID.');
      createdHere = true;
      await podman.startContainer(containerId);
    }
    const deadline = Date.now() + Math.min(Number(timeoutSec || 180), 600) * 1000;
    let port = Number(existingContainer?.proxyPort || existingContainer?.port || 0) || null;
    const previewHost = String(existingContainer?.proxyHost || existingContainer?.host || '127.0.0.1');
    while (Date.now() < deadline) {
      const info = await podman.inspectContainer(containerId).catch(() => null);
      const inspectedPort = hostPort(info);
      if (!port) port = inspectedPort;
      if (port) {
        try {
          const response = await fetch(`http://${previewHost}:${port}/health`, { signal: AbortSignal.timeout(3000) });
          if (response.ok || response.status < 500) break;
        } catch {}
      }
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
    if (!port) return e2eResult({ status: 'failed', ui_url: publicUrl(previewBaseUrl, id), test_metrics: { page_title: '', load_time_ms: 0 }, error: 'Preview port was not published by the Container Sandbox.' });
    const localUrl = `http://${previewHost}:${port}`;
    const tested = await runPlaywrightE2E({ uiUrl: localUrl, screenshotPath: screenshotPath || path.join('/tmp', `${id}-preview.png`), timeoutMs: Math.min(Number(timeoutSec || 180) * 1000, 60000), browserFactory });
    const internet = tested.internet || null;
    const status = tested.status === 'passed' && (!internet || internet.ok === true) ? 'passed' : 'failed';
    const error = tested.status !== 'passed'
      ? tested.error || 'Browser E2E failed.'
      : (!internet || internet.ok === true) ? null : 'Browser preview can load the app, but outbound Internet access was not verified.';
    return e2eResult({ ...tested, status, error, ...(internet ? { internet } : {}), ui_url: publicUrl(previewBaseUrl, id) });
  } catch (err) {
    return e2eResult({ status: 'failed', ui_url: publicUrl(previewBaseUrl, id), test_metrics: { page_title: '', load_time_ms: 0 }, error: String(err?.message || err).slice(0, 2000) });
  } finally {
    if (containerId && (createdHere || !keepRunning)) {
      await podman.stopContainer(containerId).catch(() => {});
      await podman.removeContainer(containerId).catch(() => {});
    }
  }
}

function hostPort(info) {
  const ports = info?.NetworkSettings?.Ports || info?.HostConfig?.PortBindings || {};
  const preferred = ['6080/tcp','8080/tcp','8000/tcp','7788/tcp','3000/tcp','5000/tcp','5173/tcp','4173/tcp'];
  for (const key of preferred) {
    const values = ports[key] || [];
    const host = Number(values[0]?.HostPort || 0);
    if (host) return host;
  }
  for (const values of Object.values(ports)) {
    const host = Number(values?.[0]?.HostPort || 0);
    if (host) return host;
  }
  return null;
}

function publicUrl(base, id) {
  const root = String(base || '').replace(/\/$/, '');
  return root ? `${root}/preview-${encodeURIComponent(id)}` : `/preview/${encodeURIComponent(id)}/`;
}
