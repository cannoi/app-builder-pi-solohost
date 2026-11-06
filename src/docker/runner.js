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
    const apiUrl = cfg?.runtime?.podman?.apiUrl || process.env.PODMAN_API_URL || process.env.SANDBOX_PODMAN_API_URL || process.env.CONTAINER_SANDBOX_PODMAN_API_URL || '';
    this.podman = apiUrl ? new PodmanClient({ baseUrl: apiUrl, log }) : null;
    this.podmanContainers = new Map();
  }

  configurePodman(apiUrl = '') {
    const value = String(apiUrl || '').trim();
    this.podman = value ? new PodmanClient({ baseUrl: value, log: this.log }) : null;
    return Boolean(this.podman);
  }

  refreshPodmanFromEnvironment() {
    if (this.podman) return this.podman;
    const apiUrl = this.cfg?.runtime?.podman?.apiUrl
      || process.env.PODMAN_API_URL
      || process.env.SANDBOX_PODMAN_API_URL
      || process.env.CONTAINER_SANDBOX_PODMAN_API_URL
      || '';
    if (apiUrl) this.configurePodman(apiUrl);
    return this.podman;
  }

  status() {
    const mode = String(this.cfg?.runtime?.mode || process.env.PREVIEW_MODE || 'auto').toLowerCase();
    const podman = podmanStatus(this.cfg);
    if (!this.podman && podman.configured) this.configurePodman(this.cfg?.runtime?.podman?.apiUrl || process.env.PODMAN_API_URL || '');
    if (this.podman && mode !== 'native') {
      return {
        ...podman,
        mode: 'auto',
        fallback: 'native-preview',
        dockerSocket: false,
        message: 'Automatic runtime detection is enabled. Container apps use the protected Sandbox; Node/static apps use native preview.'
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

  async buildImage({ sourcePath, projectSlug, timeout, runtimeSpec = null } = {}) {
    this.refreshPodmanFromEnvironment();
    if (!this.podman) {
      return { status: 'skipped', engine: 'native-preview', reason: 'Local image builds are disabled without the optional Container Sandbox endpoint. GitHub Actions builds the final SoloHost image.' };
    }
    const image = imageName(projectSlug);
    const detected = runtimeSpec || await detectContainerRuntime(sourcePath);
    if (detected.kind === 'compose-image' && detected.image) {
      try {
        const images = [...new Set((detected.images || [detected.image]).filter(Boolean))];
        for (const ref of images) await this.podman.pullImage(ref, { timeoutMs: (timeout || this.cfg.limits.buildTimeoutSec) * 1000 });
        return { status: 'passed', image: detected.image, sourceImage: detected.image, images, engine: 'podman-api', buildMode: 'pull-compose-image', warning: detected.multiService ? 'Compose contains multiple services. Preview runs the detected web-facing service in the single-container Sandbox profile.' : null };
      } catch (err) {
        return { status: 'failed', image: detected.image, engine: 'podman-api', error: clip(String(err?.message || err)) };
      }
    }
    const prep = await this.ensureBuildFiles(sourcePath, detected);
    if (!prep.ok) return { status: 'failed', image, error: prep.error };
    try {
      return await this.podman.buildImage({
        sourcePath: prep.contextPath || sourcePath,
        dockerfile: prep.dockerfile || 'Dockerfile',
        image,
        timeoutMs: (timeout || this.cfg.limits.buildTimeoutSec) * 1000,
      });
    } catch (err) {
      return { status: 'failed', image, engine: 'podman-api', error: clip(String(err?.message || err)) };
    }
  }

  async ensureBuildFiles(sourcePath, runtimeSpec = null) {
    const detectedFile = runtimeSpec?.kind === 'dockerfile' && runtimeSpec.file
      ? path.join(sourcePath, runtimeSpec.file)
      : path.join(sourcePath, 'Dockerfile');
    try {
      await fs.access(detectedFile);
      return { ok: true, created: false, path: detectedFile, contextPath: path.dirname(detectedFile), dockerfile: path.basename(detectedFile) };
    } catch {}
    let packageJson = null;
    try { packageJson = JSON.parse(await fs.readFile(path.join(sourcePath, 'package.json'), 'utf8')); } catch {}
    if (!packageJson) return { ok: false, created: false, error: 'Dockerfile is missing and no valid package.json is available to create one.' };
    const dockerfile = path.join(sourcePath, 'Dockerfile');
    await fs.writeFile(dockerfile, dockerfileForProject({ packageJson }), 'utf8');
    return { ok: true, created: true, path: dockerfile, contextPath: sourcePath, dockerfile: 'Dockerfile' };
  }

  async runApp({ sourcePath, projectSlug, timeout = 180, keepRunning = true } = {}) {
    this.refreshPodmanFromEnvironment();
    const mode = String(this.cfg?.runtime?.mode || process.env.PREVIEW_MODE || 'auto').toLowerCase();
    const runtimeSpec = await detectContainerRuntime(sourcePath);
    const previewable = await hasPreviewableSource(sourcePath);
    const containerOnly = !previewable && ['dockerfile', 'compose', 'compose-image'].includes(runtimeSpec.kind);
    // Ordinary generated apps include Dockerfile + docker-compose.yml for SoloHost
    // publish. Those are NOT container-only apps. Preview them natively.
    if (containerOnly && this.podman && mode !== 'native') {
      return this.runPodmanApp({ sourcePath, projectSlug, timeout, keepRunning });
    }
    return this.native.run({ sourcePath, projectSlug, timeout, keepRunning });
  }

  async runPodmanApp({ sourcePath, projectSlug, timeout = 180, keepRunning = true } = {}) {
    this.refreshPodmanFromEnvironment();
    if (!this.podman) return { status: 'skipped', runtime: 'podman-sandbox', error: 'Protected Container Sandbox is not available in this environment.' };
    const safeSlug = slug(projectSlug);
    const image = imageName(safeSlug);
    const containerName = `${APP_CONTAINER_PREFIX}${safeSlug}`.slice(0, 63);
    const started = Date.now();
    await this.stopApp({ projectSlug: safeSlug, removeImage: false }).catch(() => {});
    const runtimeSpec = await detectContainerRuntime(sourcePath);
    const built = await this.buildImage({ sourcePath, projectSlug: safeSlug, timeout, runtimeSpec });
    if (built.status !== 'passed') return { ...built, runtime: 'podman-sandbox' };

    let containerId = null;
    try {
      const runtimeImage = built.image || image;
      let imageInfo = await this.podman.imageInfo(runtimeImage).catch(() => null);
      const imagePorts = imageInfo?.Config?.ExposedPorts ? Object.keys(imageInfo.Config.ExposedPorts).map((v) => Number(String(v).split('/')[0])).filter(Boolean) : [];
      const containerPort = Number(runtimeSpec?.webPort || 0) || chooseWebPort(imagePorts) || 0;
      const created = await this.podman.createPreviewContainer({ image: runtimeImage, name: containerName, port: containerPort, runtime: runtimeSpec.compose || null });
      containerId = created.Id || created.id;
      if (!containerId) throw new Error('Container Sandbox did not return a preview container ID.');
      this.podmanContainers.set(safeSlug, { id: containerId, image: runtimeImage, name: containerName, proxyHost: null, proxyPort: null });
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
        const info = await this.podman.inspectContainer(containerId).catch(() => null);
        if (info?.State?.Running && !runtimeSpec?.hasWebPort && !port) {
          if (!keepRunning) await this.stopApp({ projectSlug: safeSlug, removeImage: false }).catch(() => {});
          return { status: 'passed', runtime: 'podman-sandbox', engine: 'podman-api', image: runtimeImage, container: containerName, containerId, hostPort: null, previewable: false, health: true, logs: clip(logs), warning: 'Container is running but does not expose a detectable web port; browser preview was skipped.', keptRunning: Boolean(keepRunning), sandbox: { memoryMb: 768, cpus: 1.5, hostBind: '127.0.0.1' } };
        }
        const result = { status: 'failed', runtime: 'podman-sandbox', image: runtimeImage, container: containerName, containerId, hostPort: port, health: false, logs: clip(logs), error: `${lastError} ${clip(logs, 1800)}`.trim() };
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
        image: runtimeImage,
        appId: safeSlug,
        previewBaseUrl: '',
        screenshotPath: path.join(artifactDir, `${safeSlug}-preview.png`),
        timeoutSec: Math.min(Number(timeout || 180), 600),
        browserFactory: this.browserFactory,
        existingContainer: { id: containerId, port, host: proxyTarget.host, proxyHost: proxyTarget.host, proxyPort: proxyTarget.port },
        keepRunning: Boolean(keepRunning),
      });

      // The E2E helper only tears down when keepRunning is false.
      const browserRequired = this.cfg?.preview?.requireBrowserTest === true;
      if (e2e.status !== 'passed' && browserRequired) {
        const logs = await this.podman.containerLogs(containerId).catch(() => '');
        await this.stopApp({ projectSlug: safeSlug, removeImage: false }).catch(() => {});
        return { status: 'failed', runtime: 'podman-sandbox', image: runtimeImage, container: containerName, containerId, hostPort: port, url: localUrl, previewPath: `/preview/${safeSlug}/`, duration: Math.round((Date.now() - started) / 1000), health: true, logs: clip(logs), e2e, error: e2e.error || 'Preview browser test failed.' };
      }

      const logs = await this.podman.containerLogs(containerId).catch(() => '');
      if (!keepRunning) this.podmanContainers.delete(safeSlug);
      return {
        status: 'passed', runtime: 'podman-sandbox', engine: 'podman-api', image: runtimeImage, container: containerName, containerId,
        containerIp: proxyTarget.host, hostPort: port, proxyHost: proxyTarget.host, proxyPort: proxyTarget.port, url: localUrl, previewPath: `/preview/${safeSlug}/`, duration: Math.round((Date.now() - started) / 1000), health: true,
        logs: clip(logs), e2e, internet: e2e.internet || null, keptRunning: Boolean(keepRunning), warning: e2e.status !== 'passed' ? (e2e.error || 'Browser E2E was not required and was recorded as a diagnostic warning.') : null, sandbox: { memoryMb: 768, cpus: 1.5, hostBind: '127.0.0.1' },
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
  for (const ip of ips) add(ip, port || 8080);
  if (port) add('host.containers.internal', port);
  if (port) add('host.docker.internal', port);
  if (port) add('127.0.0.1', port);
  try { add(new URL(apiBase).hostname, port); } catch {}
  return out;
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

async function hasPreviewableSource(sourcePath) {
  const names = [
    'index.html',
    'public/index.html',
    'dist/index.html',
    'www/index.html',
    'static/index.html',
    'package.json',
    'server.js',
    'src/server.js',
    'app.js',
    'src/app.js',
  ];
  for (const name of names) {
    try {
      await fs.access(path.join(sourcePath, name));
      if (name === 'package.json') {
        try {
          const pkg = JSON.parse(await fs.readFile(path.join(sourcePath, name), 'utf8'));
          if (pkg?.scripts?.start || pkg?.main) return true;
        } catch {
          continue;
        }
      } else {
        return true;
      }
    } catch {}
  }
  const stack = [sourcePath];
  let depth = 0;
  while (stack.length && depth < 80) {
    depth += 1;
    const dir = stack.pop();
    let entries = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (/^index\.html?$/i.test(e.name)) return true;
    }
  }
  return false;
}

async function detectContainerRuntime(sourcePath) {
  const composeNames = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
  const candidates = await findRuntimeFiles(sourcePath, composeNames, 5);
  for (const file of candidates) {
    try {
      const text = await fs.readFile(file, 'utf8');
      const services = parseComposeServices(text);
      const selected = chooseComposeService(services);
      const image = selected?.image || firstMatch(text, /^\s*image:\s*([^\s#]+)\s*$/m);
      const ports = selected?.ports?.length ? selected.ports : parsePublishedPorts(text);
      const webPort = ports.length ? chooseWebPort(ports) : 0;
      const images = services.map((x) => x.image).filter(Boolean);
      return {
        kind: image ? 'compose-image' : 'compose',
        image,
        images: [...new Set(images)],
        webPort,
        file: path.relative(sourcePath, file),
        service: selected?.name || null,
        services: services.map((x) => ({ name: x.name, image: x.image, ports: x.ports })),
        multiService: services.length > 1,
        hasWebPort: ports.length > 0,
        compose: selected ? { ...parseComposeRuntime(selected.text), service: selected.name, serviceCount: services.length } : null,
      };
    } catch {}
  }
  const dockerfiles = await findRuntimeFiles(sourcePath, ['Dockerfile'], 5);
  for (const file of dockerfiles) {
    try {
      const text = await fs.readFile(file, 'utf8');
      const ports = [...text.matchAll(/^\s*EXPOSE\s+(.+)$/gmi)]
        .flatMap((m) => m[1].split(/\s+/).map((v) => Number(String(v).split('/')[0])).filter(Boolean));
      return { kind: 'dockerfile', webPort: ports.length ? chooseWebPort(ports) : 0, file: path.relative(sourcePath, file), images: [], multiService: false, hasWebPort: ports.length > 0 };
    } catch {}
  }
  return { kind: 'unknown', webPort: 0, images: [], multiService: false, hasWebPort: false };
}

function parseComposeServices(text) {
  const src = String(text || '').replace(/\t/g, '  ');
  const lines = src.split(/\r?\n/);
  const services = [];
  let inServices = false;
  let current = null;
  let block = [];
  const flush = () => {
    if (!current) return;
    const blockText = block.join('\n');
    const image = firstMatch(blockText, /^\s*image:\s*([^\s#]+)\s*$/m);
    const ports = parsePublishedPorts(blockText);
    services.push({ name: current, image, ports, text: blockText });
    current = null; block = [];
  };
  for (const line of lines) {
    if (/^\s*services:\s*$/.test(line)) { flush(); inServices = true; continue; }
    if (!inServices) continue;
    if (/^\S/.test(line) && line.trim() && !line.startsWith('#')) { flush(); inServices = false; continue; }
    const m = line.match(/^\s{2}([A-Za-z0-9_.-]+):\s*$/);
    if (m) { flush(); current = m[1]; block = [line]; continue; }
    if (current) block.push(line);
  }
  flush();
  return services;
}

function chooseComposeService(services = []) {
  if (!services.length) return null;
  return [...services].sort((a, b) => {
    const score = (x) => (x.ports.length ? 100 : 0) + (/web|app|browser|frontend|ui|proxy/i.test(x.name || '') ? 20 : 0) + (x.image ? 5 : 0);
    return score(b) - score(a);
  })[0];
}

async function findRuntimeFiles(root, names, maxDepth = 4, depth = 0, out = []) {
  if (depth > maxDepth || out.length >= 20) return out;
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const lower = entry.name.toLowerCase();
    if (['node_modules', '.git', '__macosx'].includes(lower)) continue;
    const full = path.join(root, entry.name);
    if (entry.isFile() && wanted.has(lower)) out.push(full);
    else if (entry.isDirectory()) await findRuntimeFiles(full, names, maxDepth, depth + 1, out);
  }
  return out;
}

function parsePublishedPorts(text) {
  const ports = [];
  const lines = String(text || '').split(/\r?\n/);
  const addScalar = (raw) => {
    let value = String(raw || '').trim().replace(/^['"]|['"]$/g, '').split('/')[0];
    if (!value) return;
    const parts = value.split(':');
    const candidate = parts.length >= 2 ? String(parts.at(-1)).split('-')[0] : String(parts[0]).split('-')[0];
    if (/^\d+$/.test(candidate)) ports.push(Number(candidate));
  };
  const parseSection = (key) => {
    const headerRe = new RegExp('^(\\s*)' + key + ':\\s*(.*)$', 'i');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(headerRe);
      if (!m) continue;
      const base = m[1].length;
      if (m[2].trim().startsWith('[')) {
        for (const item of m[2].trim().replace(/^\[|\]$/g, '').split(',')) addScalar(item);
        continue;
      }
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j];
        if (!line.trim()) continue;
        const indent = (line.match(/^\s*/) || [''])[0].length;
        if (indent <= base) break;
        const item = line.trim().match(/^[-]\s*(.+)$/);
        if (item) { addScalar(item[1]); continue; }
        const target = line.trim().match(/^target:\s*['"]?(\d+)/i);
        if (target) ports.push(Number(target[1]));
      }
    }
  };
  parseSection('ports');
  parseSection('expose');
  for (const m of lines.join('\n').matchAll(/\bEXPOSE\s+([^\n]+)/gi)) {
    for (const token of m[1].split(/\s+/)) addScalar(token);
  }
  return [...new Set(ports.filter((n) => n > 0 && n < 65536))];
}

function chooseWebPort(ports = []) {
  const preferred = [6080, 8080, 8000, 7788, 3000, 5000, 5173, 4173];
  return preferred.find((p) => ports.includes(p)) || ports[0] || 8080;
}

function parseComposeRuntime(text) {
  const src = String(text || '');
  const env = [];
  const envBlock = src.match(/(?:^|\n)\s*environment:\s*\n([\s\S]*?)(?=\n\s{2,}\S[^\n]*:\s*$|\n\s{0,2}\S[^\n]*:\s*$|$)/m)?.[1] || '';
  for (const line of envBlock.split(/\r?\n/)) {
    const m = line.match(/^\s*-\s*([^#\n]+?)\s*$/);
    if (m) env.push(m[1].trim());
    else {
      const kv = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*?)\s*$/);
      if (kv) env.push(`${kv[1]}=${stripYamlScalar(kv[2])}`);
    }
  }
  const commandMatch = src.match(/(?:^|\n)\s*command:\s*(.+)$/m);
  const command = commandMatch ? parseYamlCommand(commandMatch[1].trim()) : null;
  const shmMatch = src.match(/(?:^|\n)\s*shm_size:\s*['"]?([0-9]+)([kKmMgG])?[bB]?['"]?\s*$/m);
  const shmSize = shmMatch ? toBytes(Number(shmMatch[1]), shmMatch[2]) : null;
  return { env, command, shmSize };
}

function parseYamlCommand(value) {
  const v = stripYamlScalar(value);
  if (!v) return null;
  if (v.startsWith('[') && v.endsWith(']')) {
    try { return JSON.parse(v.replace(/'/g, '"')); } catch {}
  }
  return ['sh', '-lc', v];
}

function stripYamlScalar(value) {
  const v = String(value || '').trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

function toBytes(value, unit = '') {
  const n = Number(value || 0);
  const u = String(unit || '').toLowerCase();
  if (u === 'g') return n * 1024 * 1024 * 1024;
  if (u === 'm') return n * 1024 * 1024;
  if (u === 'k') return n * 1024;
  return n;
}

function firstMatch(text, re) {
  const m = String(text || '').match(re);
  return m?.[1]?.trim() || null;
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
