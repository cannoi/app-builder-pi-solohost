import fs from 'node:fs/promises';
import path from 'node:path';
import { NativePreview } from '../runtime/native-preview.js';
import { PodmanClient, podmanStatus } from '../sandbox/podman.js';
import { runSandboxE2E } from '../sandbox/e2e-agent.js';

const APP_CONTAINER_PREFIX = 'paf-app-';
const APP_IMAGE_PREFIX = 'paf-preview:';

export class BuildRunner {
  constructor({ cfg, log, browserFactory = null } = {}) {
    this.cfg = cfg;
    this.log = log;
    this.browserFactory = browserFactory;
    this.native = new NativePreview({ cfg, log, browserFactory });
    const apiUrl = cfg?.runtime?.podman?.apiUrl || process.env.PODMAN_API_URL || '';
    this.podman = apiUrl ? new PodmanClient({ baseUrl: apiUrl, log }) : null;
    this.podmanContainers = new Map();
  }

  status() {
    const mode = String(this.cfg?.runtime?.mode || process.env.PREVIEW_MODE || 'auto').toLowerCase();
    const podman = podmanStatus(this.cfg);
    if (this.podman && mode !== 'native') {
      return {
        ...podman,
        mode: 'container',
        fallback: 'native-preview',
        dockerSocket: false,
        message: 'Container Sandbox is enabled. No host Docker socket is used.'
      };
    }
    return {
      engine: 'native-preview',
      mode: 'native',
      usable: true,
      socketPresent: false,
      dockerSocket: false,
      containerSandboxConfigured: Boolean(this.podman),
      message: this.podman && mode === 'native'
        ? 'Native preview is selected. Container Sandbox is available as an optional engine.'
        : 'Native preview is available. No host Docker access is used.'
    };
  }

  async run(spec = {}) {
    return this.runApp({
      sourcePath: spec.sourcePath,
      projectSlug: spec.projectSlug,
      timeout: spec.timeout || this.cfg.limits.sandboxTimeoutSec,
      keepRunning: false,
    });
  }

  async buildImage({ sourcePath, projectSlug, timeout } = {}) {
    if (!this.podman) {
      return { status: 'skipped', engine: 'native-preview', reason: 'Local image builds are disabled without the optional Container Sandbox endpoint. GitHub Actions builds the final SoloHost image.' };
    }
    const image = imageName(projectSlug);
    const prep = await this.ensureBuildFiles(sourcePath);
    if (!prep.ok) return { status: 'failed', image, error: prep.error };
    try {
      return await this.podman.buildImage({ sourcePath, image, timeoutMs: (timeout || this.cfg.limits.buildTimeoutSec) * 1000 });
    } catch (err) {
      return { status: 'failed', image, engine: 'podman-api', error: clip(String(err?.message || err)) };
    }
  }

  async ensureBuildFiles(sourcePath) {
    const dockerfile = path.join(sourcePath, 'Dockerfile');
    try {
      await fs.access(dockerfile);
      return { ok: true, created: false, path: dockerfile };
    } catch {}
    let packageJson = null;
    try { packageJson = JSON.parse(await fs.readFile(path.join(sourcePath, 'package.json'), 'utf8')); } catch {}
    if (!packageJson) return { ok: false, created: false, error: 'Dockerfile is missing and no valid package.json is available to create one.' };
    await fs.writeFile(dockerfile, dockerfileForProject({ packageJson }), 'utf8');
    return { ok: true, created: true, path: dockerfile };
  }

  async runApp({ sourcePath, projectSlug, timeout = 180, keepRunning = true } = {}) {
    const mode = String(this.cfg?.runtime?.mode || process.env.PREVIEW_MODE || 'auto').toLowerCase();
    if (this.podman && mode !== 'native') {
      const result = await this.runPodmanApp({ sourcePath, projectSlug, timeout, keepRunning });
      if (result.status === 'passed' || mode === 'container') return result;
      this.log?.warn?.('container preview failed; falling back to native preview', { error: result.error });
    }
    return this.native.run({ sourcePath, projectSlug, timeout, keepRunning });
  }

  async runPodmanApp({ sourcePath, projectSlug, timeout = 180, keepRunning = true } = {}) {
    if (!this.podman) return { status: 'skipped', runtime: 'podman-sandbox', error: 'Container Sandbox is not configured.' };
    const safeSlug = slug(projectSlug);
    const image = imageName(safeSlug);
    const containerName = `${APP_CONTAINER_PREFIX}${safeSlug}`.slice(0, 63);
    const started = Date.now();
    await this.stopApp({ projectSlug: safeSlug, removeImage: false }).catch(() => {});
    const built = await this.buildImage({ sourcePath, projectSlug: safeSlug, timeout });
    if (built.status !== 'passed') return { ...built, runtime: 'podman-sandbox' };

    let containerId = null;
    try {
      const created = await this.podman.createPreviewContainer({ image, name: containerName });
      containerId = created.Id || created.id;
      if (!containerId) throw new Error('Container Sandbox did not return a preview container ID.');
      this.podmanContainers.set(safeSlug, { id: containerId, image, name: containerName, proxyHost: null, proxyPort: null });
      await this.podman.startContainer(containerId);

      const deadline = Date.now() + Math.min(Number(timeout || 180), 600) * 1000;
      let port = null;
      let proxyTarget = null;
      let lastError = 'Waiting for the sandbox preview to start.';
      while (Date.now() < deadline) {
        const info = await this.podman.inspectContainer(containerId).catch(() => null);
        port = hostPort(info);
        const candidates = previewTargets(info, port, this.podman.baseUrl);
        for (const candidate of candidates) {
          const probe = await probeHttp(candidate.host, candidate.port, '/health');
          if (probe.ok) { proxyTarget = candidate; break; }
          const rootProbe = await probeHttp(candidate.host, candidate.port, '/');
          if (rootProbe.ok) { proxyTarget = candidate; break; }
          if (probe.error) lastError = probe.error;
        }
        if (proxyTarget) break;
        if (info?.State?.Running === false && info?.State?.ExitCode != null) {
          lastError = `Preview container exited with code ${info.State.ExitCode}.`;
          break;
        }
        await sleep(800);
      }
      if (!proxyTarget) {
        const logs = await this.podman.containerLogs(containerId).catch(() => '');
        const result = { status: 'failed', runtime: 'podman-sandbox', image, container: containerName, containerId, hostPort: port, health: false, logs: clip(logs), error: `${lastError} ${clip(logs, 1800)}`.trim() };
        await this.stopApp({ projectSlug: safeSlug, removeImage: false }).catch(() => {});
        return result;
      }

      const localUrl = `http://${proxyTarget.host}:${proxyTarget.port}`;
      const tracked = this.podmanContainers.get(safeSlug);
      if (tracked) { tracked.proxyHost = proxyTarget.host; tracked.proxyPort = proxyTarget.port; tracked.port = port; }
      const artifactDir = path.join(path.dirname(sourcePath), 'artifacts');
      await fs.mkdir(artifactDir, { recursive: true });
      const e2e = await runSandboxE2E({
        podman: this.podman,
        image,
        appId: safeSlug,
        previewBaseUrl: '',
        screenshotPath: path.join(artifactDir, `${safeSlug}-preview.png`),
        timeoutSec: Math.min(Number(timeout || 180), 600),
        browserFactory: this.browserFactory,
        existingContainer: { id: containerId, port },
        keepRunning: Boolean(keepRunning),
      });

      // The E2E helper only tears down when keepRunning is false.
      if (e2e.status !== 'passed') {
        const logs = await this.podman.containerLogs(containerId).catch(() => '');
        await this.stopApp({ projectSlug: safeSlug, removeImage: false }).catch(() => {});
        return { status: 'failed', runtime: 'podman-sandbox', image, container: containerName, containerId, hostPort: port, url: localUrl, previewPath: `/preview/${safeSlug}/`, duration: Math.round((Date.now() - started) / 1000), health: true, logs: clip(logs), e2e, error: e2e.error || 'Preview browser test failed.' };
      }

      const logs = await this.podman.containerLogs(containerId).catch(() => '');
      if (!keepRunning) this.podmanContainers.delete(safeSlug);
      return {
        status: 'passed', runtime: 'podman-sandbox', engine: 'podman-api', image, container: containerName, containerId,
        containerIp: proxyTarget.host, hostPort: port, proxyHost: proxyTarget.host, proxyPort: proxyTarget.port, url: localUrl, previewPath: `/preview/${safeSlug}/`, duration: Math.round((Date.now() - started) / 1000), health: true,
        logs: clip(logs), e2e, internet: e2e.internet || null, keptRunning: Boolean(keepRunning), sandbox: { memoryMb: 512, cpus: 1, hostBind: '127.0.0.1' },
      };
    } catch (err) {
      await this.stopApp({ projectSlug: safeSlug, removeImage: false }).catch(() => {});
      return { status: 'failed', runtime: 'podman-sandbox', image, container: containerName, containerId, duration: Math.round((Date.now() - started) / 1000), health: false, error: clip(String(err?.message || err)) };
    }
  }

  async stopApp({ projectSlug, removeImage = true } = {}) {
    const safeSlug = slug(projectSlug);
    const item = this.podmanContainers.get(safeSlug);
    if (this.podman && item) {
      await this.podman.stopContainer(item.id).catch(() => {});
      await this.podman.removeContainer(item.id).catch(() => {});
      if (removeImage) await this.podman.removeImage(item.image).catch(() => {});
      this.podmanContainers.delete(safeSlug);
      return { status: 'stopped', runtime: 'podman-sandbox', container: item.name, image: item.image };
    }
    if (this.podman) {
      const name = `${APP_CONTAINER_PREFIX}${safeSlug}`.slice(0, 63);
      const containers = await this.podman.listContainers(true).catch(() => []);
      const found = Array.isArray(containers) ? containers.find((c) => c.Names?.includes(`/${name}`) || c.Id === name) : null;
      if (found) await this.podman.removeContainer(found.Id || found.id).catch(() => {});
      if (removeImage) await this.podman.removeImage(imageName(safeSlug)).catch(() => {});
      return { status: 'stopped', runtime: 'podman-sandbox', container: name, image: imageName(safeSlug) };
    }
    return this.native.stop({ projectSlug: safeSlug });
  }

  async appStatus({ projectSlug } = {}) {
    const safeSlug = slug(projectSlug);
    const item = this.podmanContainers.get(safeSlug);
    if (this.podman && item) {
      const info = await this.podman.inspectContainer(item.id).catch(() => null);
      if (!info) { this.podmanContainers.delete(safeSlug); return { status: 'stopped', runtime: 'podman-sandbox', hostPort: null, url: null }; }
      const port = hostPort(info) || item.port || null;
      const host = item.proxyHost || null;
      const pport = item.proxyPort || port || null;
      return { status: info.State?.Running ? 'running' : 'stopped', runtime: 'podman-sandbox', container: item.name, containerId: item.id, hostPort: port, containerIp: host, proxyHost: host, proxyPort: pport, url: host && pport ? `http://${host}:${pport}` : null, previewPath: `/preview/${safeSlug}/` };
    }
    if (this.podman) return { status: 'stopped', runtime: 'podman-sandbox', hostPort: null, url: null };
    return this.native.status({ projectSlug: safeSlug });
  }

  async execSandbox() {
    return { status: 'blocked', runtime: this.podman ? 'podman-sandbox' : 'native-preview', error: 'Raw shell commands are disabled. Use Build, Run, Check, or Improve.' };
  }

  async listContainers({ all = false } = {}) {
    if (this.podman) {
      try {
        const items = await this.podman.listContainers(all);
        return { status: 'passed', engine: 'podman-api', items: Array.isArray(items) ? items : [] };
      } catch (err) { return { status: 'failed', engine: 'podman-api', items: [], error: clip(String(err?.message || err)) }; }
    }
    return { status: 'passed', engine: 'native-preview', items: [] };
  }

  async inspectContainer(id) {
    if (!this.podman) return { status: 'blocked', engine: 'native-preview', error: 'Container inspection is available only when the optional Container Sandbox is configured.' };
    try { return await this.podman.inspectContainer(id); } catch (err) { return { status: 'failed', engine: 'podman-api', error: clip(String(err?.message || err)) }; }
  }

  async logs(id) {
    if (!this.podman) return '';
    return this.podman.containerLogs(id).catch(() => '');
  }

  async imageInfo(image) {
    if (!this.podman) return { status: 'blocked', engine: 'native-preview', error: 'Image inspection is unavailable without Container Sandbox.' };
    try { return await this.podman.imageInfo(image); } catch (err) { return { status: 'failed', error: clip(String(err?.message || err)) }; }
  }

  async imageHistory(image) {
    if (!this.podman) return { status: 'blocked', engine: 'native-preview', items: [] };
    return { status: 'passed', engine: 'podman-api', items: await this.podman.inspectImageHistory(image) };
  }

  async exportImage(image, destination) {
    if (!this.podman) return { status: 'blocked', error: 'Local image export requires the optional Container Sandbox.' };
    return this.podman.exportImage(image, destination);
  }

  async exportContainer() { return { status: 'blocked', error: 'Container import/export is disabled in native preview mode.' }; }
  async pushImage() { return { status: 'skipped', reason: 'Final GHCR publication is handled by GitHub Actions.' }; }

  async verifyImage(image) {
    if (!this.podman) return { ok: false, error: 'Container Sandbox is not configured.' };
    try { const info = await this.podman.imageInfo(image); return { ok: Boolean(info), id: info?.Id || info?.Id || null }; }
    catch (err) { return { ok: false, error: clip(String(err?.message || err)) }; }
  }
}

async function probeHttp(host, port, pathname = '/') {
  try {
    const r = await fetch(`http://${host}:${port}${pathname}`, { signal: AbortSignal.timeout(1200), redirect: 'manual' });
    return { ok: r.status < 500 };
  } catch (err) {
    return { ok: false, error: `${host}:${port} is unreachable (${String(err?.message || err).slice(0, 160)})` };
  }
}

function previewTargets(info, port, apiBase) {
  const out = [];
  const seen = new Set();
  const add = (host, p) => {
    if (!host || !p) return;
    const key = `${host}:${p}`;
    if (seen.has(key)) return;
    seen.add(key); out.push({ host, port: Number(p) });
  };
  const ips = info?.NetworkSettings?.Networks ? Object.values(info.NetworkSettings.Networks).map((n) => n?.IPAddress).filter(Boolean) : [];
  for (const ip of ips) add(ip, 8080);
  if (port) add('host.containers.internal', port);
  if (port) add('host.docker.internal', port);
  if (port) add('127.0.0.1', port);
  try { add(new URL(apiBase).hostname, port); } catch {}
  return out;
}

function hostPort(info) {
  const values = info?.NetworkSettings?.Ports?.['8080/tcp'] || info?.HostConfig?.PortBindings?.['8080/tcp'] || [];
  return Number(values[0]?.HostPort || 0) || null;
}

function imageName(projectSlug) {
  return `${APP_IMAGE_PREFIX}${slug(projectSlug)}-${Date.now()}`.slice(0, 120);
}

function slug(value) { return String(value || 'app').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 50) || 'app'; }
function clip(value, n = 12000) { return String(value || '').slice(-n); }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function dockerfileForProject({ packageJson }) {
  const start = String(packageJson?.scripts?.start || '').trim();
  const command = start === 'node src/server.js' ? ['node', 'src/server.js'] : start ? ['sh', '-lc', start] : ['node', String(packageJson?.main || 'src/server.js')];
  return `FROM node:24-alpine\nWORKDIR /app\n\nCOPY package*.json ./\nRUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi\nCOPY . .\n\nENV PORT=8080\nENV BIND=0.0.0.0\nEXPOSE 8080\n\nLABEL org.opencontainers.image.source="https://github.com/cannoi/app-builder-pi-solohost"\n\nHEALTHCHECK --interval=20s --timeout=5s --start-period=10s --retries=3 \\\n  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"\n\nCMD ${JSON.stringify(command)}\n`;
}
