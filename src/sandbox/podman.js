import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const API_VERSION = '/v1.40';

export class PodmanClient {
  constructor({ baseUrl = process.env.PODMAN_API_URL || '', fetchImpl = globalThis.fetch, log = null } = {}) {
    this.baseUrl = String(baseUrl || '').replace(/\/$/, '');
    this.fetch = fetchImpl;
    this.log = log;
  }

  configured() { return Boolean(this.baseUrl); }

  async request(pathname, options = {}) {
    if (!this.baseUrl) throw new Error('Podman API is not configured. Set PODMAN_API_URL to a protected Podman REST endpoint.');
    const url = `${this.baseUrl}${API_VERSION}${pathname}`;
    const headers = { 'X-App-Builder-Engine': 'podman-api', ...(options.headers || {}) };
    const response = await this.fetch(url, { ...options, headers });
    const text = await response.text();
    if (!response.ok) throw new Error(`Podman API HTTP ${response.status}: ${text.slice(0, 1800)}`);
    if (!text) return {};
    try { return JSON.parse(text); } catch { return text; }
  }

  async ping() { return this.request('/_ping'); }

  async buildImage({ sourcePath, image, timeoutMs = 900000 }) {
    const archive = path.join(await fs.mkdtemp('/tmp/paf-podman-build-'), 'context.tar');
    try {
      await exec('tar', ['-cf', archive, '--exclude=./node_modules', '--exclude=./data', '--exclude=./workspace', '--exclude=./projects', '.'], { cwd: sourcePath, timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
      const body = await fs.readFile(archive);
      const url = `${this.baseUrl}${API_VERSION}/build?dockerfile=Dockerfile&t=${encodeURIComponent(image)}&pull=true&rm=true`;
      const response = await this.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-tar', 'X-App-Builder-Engine': 'podman-api' },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`Podman build HTTP ${response.status}: ${text.slice(0, 3000)}`);
      return { status: 'passed', image, output: text.slice(-10000) };
    } finally {
      await fs.rm(path.dirname(archive), { recursive: true, force: true }).catch(() => {});
    }
  }

  async imageInfo(image) { return this.request(`/images/${encodeURIComponent(image)}/json`); }

  async imageExists(image) {
    try { return Boolean(await this.imageInfo(image)); } catch { return false; }
  }

  async createPreviewContainer({ image, name, port = 8080 }) {
    const body = {
      Image: image,
      name,
      Env: ['PORT=8080', 'BIND=0.0.0.0', 'PREVIEW_ONLINE=true'],
      Labels: { 'com.pi.app-factory.project': name.replace(/^paf-app-/, ''), 'com.pi.app-factory.sandbox': 'preview' },
      HostConfig: {
        AutoRemove: true,
        Memory: 536870912,
        NanoCpus: 1000000000,
        PidsLimit: 128,
        SecurityOpt: ['no-new-privileges:true'],
        CapDrop: ['ALL'],
        NetworkMode: 'bridge',
        Dns: ['1.1.1.1', '8.8.8.8'],
        PortBindings: { [`${port}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: '' }] },
      },
      ExposedPorts: { [`${port}/tcp`]: {} },
    };
    return this.request('/containers/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  async startContainer(id) { return this.request(`/containers/${encodeURIComponent(id)}/start`, { method: 'POST' }); }
  async stopContainer(id) { return this.request(`/containers/${encodeURIComponent(id)}/stop?t=5`, { method: 'POST' }).catch(() => ({})); }
  async removeContainer(id) { return this.request(`/containers/${encodeURIComponent(id)}?force=true`, { method: 'DELETE' }).catch(() => ({})); }
  async inspectContainer(id) { return this.request(`/containers/${encodeURIComponent(id)}/json`); }

  async containerLogs(id) {
    const url = `${this.baseUrl}${API_VERSION}/containers/${encodeURIComponent(id)}/logs?stdout=true&stderr=true&tail=120`;
    const response = await this.fetch(url, { headers: { 'X-App-Builder-Engine': 'podman-api' } });
    const text = await response.text();
    if (!response.ok) throw new Error(`Podman logs HTTP ${response.status}: ${text.slice(0, 1600)}`);
    return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  }

  async listContainers(all = false) { return this.request(`/containers/json?all=${all ? 'true' : 'false'}`); }

  async removeImage(image) { return this.request(`/images/${encodeURIComponent(image)}?force=true`, { method: 'DELETE' }).catch(() => ({})); }
  async exportImage(image, destination) {
    // Always request Docker archive format so the downloaded file can be
    // imported directly with `docker load -i image.tar`. Podman supports
    // explicit export formats through the Libpod API.
    const url = `${this.baseUrl}${API_VERSION}/libpod/images/${encodeURIComponent(image)}/get?format=docker-archive&compress=false`;
    const response = await this.fetch(url, { headers: { 'X-App-Builder-Engine': 'podman-api' } });
    if (!response.ok) throw new Error(`Podman Docker-archive export HTTP ${response.status}`);
    await fs.writeFile(destination, Buffer.from(await response.arrayBuffer()));
    return { path: destination, format: 'docker-archive' };
  }


  async tagImage(image, repo, tag) {
    return this.request(`/images/${encodeURIComponent(image)}/tag?repo=${encodeURIComponent(repo)}&tag=${encodeURIComponent(tag)}`, { method: 'POST' });
  }

  async pushImage(image, registryImage, token) {
    const parts = String(registryImage).split('/');
    const repo = parts.slice(0, -1).join('/');
    const tag = parts.at(-1) || 'latest';
    await this.tagImage(image, repo, tag);
    const auth = Buffer.from(JSON.stringify({ username: repo.split('/')[1] || 'github', password: token })).toString('base64');
    const url = `${this.baseUrl}${API_VERSION}/images/${encodeURIComponent(repo)}/push?tag=${encodeURIComponent(tag)}`;
    const response = await this.fetch(url, { method: 'POST', headers: { 'X-Registry-Auth': auth, 'X-App-Builder-Engine': 'podman-api' }, signal: AbortSignal.timeout(900000) });
    const text = await response.text();
    if (!response.ok) throw new Error(`Podman push HTTP ${response.status}: ${text.slice(0, 2500)}`);
    return { status: 'passed', image: registryImage, output: text.slice(-10000) };
  }

  async execContainer(id, command) {
    const created = await this.request('/containers/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ Image: 'alpine:latest', Cmd: command }) });
    return created;
  }

  async inspectImageHistory(image) {
    try { return await this.request(`/images/${encodeURIComponent(image)}/history`); } catch { return []; }
  }
}

export function podmanStatus(cfg = {}) {
  const apiUrl = cfg.podman?.apiUrl || process.env.PODMAN_API_URL || '';
  return {
    engine: 'podman-api',
    configured: Boolean(apiUrl),
    usable: Boolean(apiUrl),
    apiUrl: apiUrl ? redactUrl(apiUrl) : null,
    message: apiUrl ? 'Podman API sandbox is configured.' : 'Podman API is not configured. Set PODMAN_API_URL to a protected endpoint.',
  };
}

function redactUrl(value) {
  try {
    const u = new URL(value);
    if (u.username) u.username = '***';
    if (u.password) u.password = '***';
    return u.toString().replace(/\/$/, '');
  } catch { return '[configured]'; }
}
