import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { dockerStatus } from './modes.js';
import { evaluateCommand } from '../security/policy.js';
import { gcDocker } from './cleanup.js';
import { runPlaywrightE2E } from '../testing/playwright.js';

const exec = promisify(execFile);
const APP_CONTAINER_PREFIX = 'paf-app-';
const APP_IMAGE_PREFIX = 'paf-app:';

export class BuildRunner {
  constructor({ cfg, log, exec: execOverride = null, browserFactory = null }) {
    this.cfg = cfg;
    this.log = log;
    this.exec = execOverride || exec;
    this.browserFactory = browserFactory;
  }

  status() {
    return dockerStatus(this.cfg.docker.mode);
  }

  async run(spec) {
    const st = this.status();
    if (!st.usable) {
      return {
        status: 'skipped',
        reason: st.mode === 'safe'
          ? 'Safe mode does not run host Docker builds.'
          : 'Docker socket is not available.',
      };
    }
    const cmd = spec.command || 'docker build .';
    if (/^docker\s+build\b/i.test(cmd)) {
      const prep = await this.ensureBuildFiles(spec.sourcePath);
      if (!prep.ok) return { status: 'failed', error: prep.error };
    }
    const verdict = evaluateCommand(cmd, { dockerMode: 'power' });
    if (!verdict.ok) return { status: 'blocked', reason: verdict.reason };
    const timeout = (spec.timeout || this.cfg.limits.buildTimeoutSec) * 1000;
    try {
      const { stdout, stderr } = await this.exec('sh', ['-c', cmd], {
        cwd: spec.sourcePath,
        timeout,
        maxBuffer: 4 * 1024 * 1024,
      });
      const tag = extractDockerTag(cmd);
      if (tag) {
        const verified = await this.verifyImage(tag);
        if (!verified.ok) return { status: 'failed', error: verified.error, stdout: clip(stdout), stderr: clip(stderr), image: tag };
        return { status: 'passed', stdout: clip(stdout), stderr: clip(stderr), image: tag, imageId: verified.id };
      }
      return { status: 'passed', stdout: clip(stdout), stderr: clip(stderr) };
    } catch (err) {
      return { status: 'failed', error: clip(String(err.stderr || err.message)) };
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
    const content = dockerfileForProject({ packageJson });
    await fs.writeFile(dockerfile, content, 'utf8');
    return { ok: true, created: true, path: dockerfile };
  }

  async verifyImage(image) {
    try {
      const { stdout } = await this.exec('docker', ['image', 'inspect', image], { timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
      const data = JSON.parse(stdout)?.[0];
      if (!data?.Id) return { ok: false, error: `Docker build completed but image ${image} could not be verified.` };
      return { ok: true, id: data.Id };
    } catch (err) {
      return { ok: false, error: clip(String(err.stderr || err.message || `Docker image ${image} could not be verified.`)) };
    }
  }

  async buildImage({ sourcePath, projectSlug, timeout }) {
    const st = this.status();
    if (!st.usable) return dockerBlocked(st);
    const image = imageName(projectSlug);
    const prep = await this.ensureBuildFiles(sourcePath);
    if (!prep.ok) return { status: 'failed', image, error: prep.error };
    try {
      const { stdout, stderr } = await this.exec('docker', ['build', '--tag', image, '.'], {
        cwd: sourcePath,
        timeout: (timeout || this.cfg.limits.buildTimeoutSec) * 1000,
        maxBuffer: 6 * 1024 * 1024,
      });
      const verified = await this.verifyImage(image);
      if (!verified.ok) return { status: 'failed', image, stdout: clip(stdout), stderr: clip(stderr), error: verified.error };
      return { status: 'passed', image, imageId: verified.id, stdout: clip(stdout), stderr: clip(stderr) };
    } catch (err) {
      return { status: 'failed', image, error: clip(String(err.stderr || err.message)) };
    }
  }

  async runApp({ sourcePath, projectSlug, timeout = 180, image = null }) {
    const st = this.status();
    if (!st.usable) return dockerBlocked(st, 'Run requires Docker POWER mode and the Docker socket.');
    const safeSlug = slug(projectSlug);
    const container = `${APP_CONTAINER_PREFIX}${safeSlug}`.slice(0, 63);
    const img = image || imageName(safeSlug);
    const started = Date.now();

    await this.stopApp({ projectSlug: safeSlug, removeImage: false }).catch(() => {});
    let built;
    if (image) {
      const verified = await this.verifyImage(image);
      if (!verified.ok) return { status: 'failed', image, error: verified.error };
      built = { status: 'passed', image, imageId: verified.id };
    } else {
      built = await this.buildImage({ sourcePath, projectSlug: safeSlug });
    }
    if (built.status !== 'passed') return built;

    try {
      await this.exec('docker', [
        'run', '-d', '--rm', '--name', container,
        '--label', `com.pi.app-factory.project=${safeSlug}`,
        '--label', 'com.pi.app-factory.preview=1',
        '--memory', '512m', '--cpus', '1',
        '--env', 'PORT=8080', '--env', 'BIND=0.0.0.0',
        '-p', '0:8080', img,
      ], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });

      const port = await this.hostPort(container).catch(() => null);
      const ip = await this.containerIp(container).catch(() => null);
      const health = await this.waitForHealth({ ip, port, timeoutSec: Math.min(timeout, 600) });
      const logs = await this.logs(container);
      if (!health.ok) {
        const error = [health.error, clip(logs)].filter(Boolean).join('\n').slice(0, 1500);
        await this.stopApp({ projectSlug: safeSlug, removeImage: false });
        await gcDocker({ keepImage: img, keepContainer: null, log: this.log });
        return {
          status: 'failed', image: img, container, hostPort: port, containerIp: ip,
          duration: Math.round((Date.now() - started) / 1000),
          health: false, logs, error: error || 'App health check failed.',
        };
      }
      const localUiUrl = ip ? `http://${ip}:8080` : (port ? `http://127.0.0.1:${port}` : null);
      let e2e = null;
      if (localUiUrl) {
        const artifactDir = path.join(path.dirname(sourcePath), 'artifacts');
        await fs.mkdir(artifactDir, { recursive: true });
        e2e = await runPlaywrightE2E({
          uiUrl: localUiUrl,
          screenshotPath: path.join(artifactDir, `${safeSlug}-preview.png`),
          timeoutMs: Math.min(Math.max(timeout * 1000, 30000), 60000),
          browserFactory: this.browserFactory,
        });
      }
      if (e2e?.status !== 'success') {
        const e2eError = e2e?.error || 'Browser E2E test failed.';
        await this.stopApp({ projectSlug: safeSlug, removeImage: false });
        await gcDocker({ keepImage: img, keepContainer: null, log: this.log });
        return {
          status: 'failed', image: img, container, hostPort: port, containerIp: ip,
          duration: Math.round((Date.now() - started) / 1000), health: true, logs,
          e2e, error: e2eError,
          url: port ? `http://127.0.0.1:${port}` : null,
          previewPath: `/preview/${safeSlug}/`,
        };
      }
      await gcDocker({ keepImage: img, keepContainer: container, log: this.log });
      return {
        status: 'passed', image: img, container, hostPort: port, containerIp: ip,
        duration: Math.round((Date.now() - started) / 1000), health: true, logs, e2e,
        url: port ? `http://127.0.0.1:${port}` : null,
        previewPath: `/preview/${safeSlug}/`,
      };
    } catch (err) {
      await this.stopApp({ projectSlug: safeSlug, removeImage: false }).catch(() => {});
      return {
        status: 'failed', image: img, container,
        duration: Math.round((Date.now() - started) / 1000), health: false,
        error: clip(String(err.stderr || err.message)),
      };
    }
  }

  async stopApp({ projectSlug, removeImage = true }) {
    const st = this.status();
    if (!st.usable) return dockerBlocked(st, 'Stopping a preview requires Docker POWER mode.');
    const safeSlug = slug(projectSlug);
    const container = `${APP_CONTAINER_PREFIX}${safeSlug}`.slice(0, 63);
    const image = imageName(safeSlug);
    await this.exec('docker', ['rm', '-f', container], { timeout: 15000 }).catch(() => {});
    if (removeImage) await this.exec('docker', ['rmi', '-f', image], { timeout: 20000 }).catch(() => {});
    return { status: 'stopped', container, image };
  }

  async appStatus({ projectSlug }) {
    const st = this.status();
    if (!st.usable) return dockerBlocked(st, 'Preview status requires Docker POWER mode.');
    const safeSlug = slug(projectSlug);
    const container = `${APP_CONTAINER_PREFIX}${safeSlug}`.slice(0, 63);
    try {
      const { stdout } = await this.exec('docker', ['inspect', '--format', '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}', container], { timeout: 10000 });
      const [status, health] = String(stdout).trim().split('|');
      const port = await this.hostPort(container).catch(() => null);
      const ip = await this.containerIp(container).catch(() => null);
      return { status: 'running', container, state: status || 'unknown', health: health || 'unknown', hostPort: port, containerIp: ip, url: port ? `http://127.0.0.1:${port}` : null, previewPath: `/preview/${safeSlug}/` };
    } catch {
      return { status: 'stopped', container, hostPort: null, url: null };
    }
  }

  async hostPort(container) {
    const { stdout } = await this.exec('docker', ['port', container, '8080/tcp'], { timeout: 10000 });
    const match = String(stdout).match(/:(\d+)\s*$/m);
    if (!match) throw new Error('Docker did not publish port 8080.');
    return Number(match[1]);
  }

  async containerIp(container) {
    const { stdout } = await this.exec('docker', ['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', container], { timeout: 10000 });
    const ip = String(stdout).trim();
    if (!ip) throw new Error('Container has no IP yet.');
    return ip;
  }

  async waitForHealth({ ip, port, timeoutSec }) {
    const deadline = Date.now() + timeoutSec * 1000;
    let last = 'Waiting for /health…';
    const targets = [];
    if (ip) targets.push(`http://${ip}:8080/health`);
    if (port) targets.push(`http://127.0.0.1:${port}/health`);
    if (!targets.length) return { ok: false, error: 'No container IP or published port.' };
    while (Date.now() < deadline) {
      for (const url of targets) {
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
          if (response.ok) return { ok: true, url };
          last = `Health returned HTTP ${response.status} at ${url}.`;
        } catch (err) {
          last = `${url}: ${String(err.message || 'failed')}`;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    return { ok: false, error: last };
  }

  async listContainers({ all = false } = {}) {
    const st = this.status();
    if (!st.usable) return dockerBlocked(st, 'Docker access is required to inspect running apps.');
    try {
      const { stdout } = await this.exec('docker', ['ps', all ? '-a' : '', '--format', '{{json .}}'].filter(Boolean), { timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
      const items = String(stdout).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)).map((x) => ({
        id: x.ID, name: x.Names, image: x.Image, state: x.State, status: x.Status, ports: x.Ports, labels: x.Labels,
      }));
      return { status: 'passed', items };
    } catch (err) {
      return { status: 'failed', error: clip(String(err.stderr || err.message)) };
    }
  }

  async inspectContainer(container) {
    const st = this.status();
    if (!st.usable) return dockerBlocked(st, 'Docker access is required to inspect an app.');
    try {
      const { stdout } = await this.exec('docker', ['inspect', container], { timeout: 15000, maxBuffer: 6 * 1024 * 1024 });
      const data = JSON.parse(stdout)?.[0];
      if (!data) throw new Error('Container not found.');
      const image = data.Config?.Image || '';
      const health = data.State?.Health || null;
      const ports = data.NetworkSettings?.Ports || {};
      const env = (data.Config?.Env || []).map((v) => String(v).replace(/=.*$/, '=***'));
      return {
        status: 'passed', id: data.Id, name: data.Name?.replace(/^\//, ''), image, created: data.Created,
        state: data.State?.Status, health: health?.Status || 'none', ports, env,
        mounts: (data.Mounts || []).map((m) => ({ type: m.Type, destination: m.Destination, rw: m.RW })),
        labels: data.Config?.Labels || {}, command: data.Config?.Cmd || [], entrypoint: data.Config?.Entrypoint || [],
      };
    } catch (err) {
      return { status: 'failed', error: clip(String(err.stderr || err.message)) };
    }
  }

  async imageInfo(image) {
    const st = this.status();
    if (!st.usable) return dockerBlocked(st, 'Docker access is required to inspect an image.');
    try {
      const { stdout } = await this.exec('docker', ['image', 'inspect', image], { timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
      const d = JSON.parse(stdout)?.[0];
      if (!d) throw new Error('Image not found.');
      return { status: 'passed', id: d.Id, repoTags: d.RepoTags || [], created: d.Created, size: d.Size, architecture: d.Architecture, os: d.Os, config: { envCount: d.Config?.Env?.length || 0, exposedPorts: d.Config?.ExposedPorts || {}, user: d.Config?.User || '' }, rootfs: d.RootFS || {} };
    } catch (err) {
      return { status: 'failed', error: clip(String(err.stderr || err.message)) };
    }
  }

  async imageHistory(image) {
    const st = this.status();
    if (!st.usable) return dockerBlocked(st, 'Docker access is required to inspect image history.');
    try {
      const { stdout } = await this.exec('docker', ['history', '--no-trunc', '--format', '{{json .}}', image], { timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
      return { status: 'passed', items: String(stdout).trim().split('\n').filter(Boolean).map((x) => JSON.parse(x)).slice(0, 60) };
    } catch (err) { return { status: 'failed', error: clip(String(err.stderr || err.message)) }; }
  }

  async exportContainer(container, destDir, maxBytes = 250 * 1024 * 1024) {
    const st = this.status();
    if (!st.usable) return dockerBlocked(st, 'Docker access is required to copy an app into a project.');
    const tarPath = path.join(destDir, '_container.tar');
    await fs.mkdir(destDir, { recursive: true });
    try {
      await this.exec('docker', ['export', container, '-o', tarPath], { timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
      const stat = await fs.stat(tarPath);
      if (stat.size > maxBytes) throw new Error(`Container export is too large (${Math.round(stat.size / 1024 / 1024)} MB).`);
      const { stdout } = await this.exec('tar', ['-tf', tarPath], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
      const unsafe = String(stdout).split('\n').filter(Boolean).some((name) => name.startsWith('/') || name.includes('../') || name.includes('..\\'));
      if (unsafe) throw new Error('Container export contains unsafe paths.');
      await this.exec('tar', ['-xf', tarPath, '-C', destDir, '--no-same-owner', '--no-same-permissions'], { timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
      return { status: 'passed', bytes: stat.size };
    } catch (err) { return { status: 'failed', error: clip(String(err.stderr || err.message)) }; }
    finally { await fs.rm(tarPath, { force: true }).catch(() => {}); }
  }

  async exportImage({ image, destination }) {
    const st = this.status();
    if (!st.usable) return dockerBlocked(st, 'Docker access is required to save the app image.');
    if (!image) return { status: 'failed', error: 'No image name to export.' };
    try {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await this.exec('docker', ['save', '-o', destination, image], { timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
      const stat = await fs.stat(destination).catch(() => null);
      return {
        status: 'passed',
        image,
        path: destination,
        filename: path.basename(destination),
        bytes: stat?.size || 0,
        format: 'docker-archive',
      };
    } catch (err) {
      return { status: 'failed', image, error: clip(String(err.stderr || err.message)) };
    }
  }

  async pushImage({ image, registryImage, token, timeout = 900 }) {
    const st = this.status();
    if (!st.usable) return dockerBlocked(st, 'Docker access is required to publish the app image.');
    if (!token) return { status: 'blocked', reason: 'A registry token is required.' };
    try {
      await this.exec('docker', ['tag', image, registryImage], { timeout: 30000 });
      const user = String(registryImage).split('/')[1] || 'github';
      await execWithStdin('docker', ['login', 'ghcr.io', '-u', user, '--password-stdin'], `${token}\n`, 30000);
      const { stdout, stderr } = await this.exec('docker', ['push', registryImage], { timeout: timeout * 1000, maxBuffer: 6 * 1024 * 1024 });
      return { status: 'passed', image: registryImage, stdout: clip(stdout), stderr: clip(stderr) };
    } catch (err) { return { status: 'failed', image: registryImage, error: clip(String(err.stderr || err.message)) }; }
  }

  async execSandbox({ sourcePath, image, command, timeout = 120 }) {
    const st = this.status();
    if (!st.usable) return dockerBlocked(st, 'Docker access is required for the isolated command sandbox.');
    const safeCommand = String(command || '').trim();
    if (!safeCommand) return { status: 'failed', error: 'Sandbox command is empty.' };
    const started = Date.now();
    const tempRoot = await fs.mkdtemp('/tmp/paf-sandbox-');
    const sandboxPath = path.join(tempRoot, 'workspace');
    await fs.cp(sourcePath, sandboxPath, { recursive: true, force: true });
    if (!image) {
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
      return { status: 'blocked', error: 'Sandbox skipped. Use Build / Run / Check instead of raw commands.' };
    }
    const args = ['run', '--rm', '--network', 'bridge', '--memory', '512m', '--cpus', '1', '--pids-limit', '128', '--label', 'com.pi.app-factory.sandbox=1', '-v', `${sandboxPath}:/workspace:rw`, '-w', '/workspace', '--entrypoint', '/bin/sh', image, '-lc', safeCommand];
    try {
      const { stdout, stderr } = await this.exec('docker', args, { timeout: timeout * 1000, maxBuffer: 6 * 1024 * 1024 });
      return { status: 'passed', stdout: clip(stdout), stderr: clip(stderr), duration: Math.round((Date.now() - started) / 1000), isolated: true };
    } catch (err) {
      return { status: 'failed', error: clip(String(err.stderr || err.stdout || err.message)), duration: Math.round((Date.now() - started) / 1000), isolated: true };
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  async logs(container) {
    try {
      const { stdout, stderr } = await this.exec('docker', ['logs', '--tail', '120', container], { timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
      return clip(`${stdout || ''}${stderr || ''}`);
    } catch (err) {
      return clip(String(err.stderr || err.message));
    }
  }
}


export function dockerfileForProject({ packageJson }) {
  const start = String(packageJson?.scripts?.start || '').trim();
  const command = start === 'node src/server.js'
    ? ['node', 'src/server.js']
    : start
      ? ['sh', '-lc', start]
      : ['node', 'src/server.js'];
  return `FROM node:24-alpine
WORKDIR /app

COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi
COPY . .

ENV PORT=8080
ENV BIND=0.0.0.0
EXPOSE 8080

HEALTHCHECK --interval=20s --timeout=5s --start-period=10s --retries=3 \\
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ${JSON.stringify(command)}
`;
}

function extractDockerTag(command) {
  const m = String(command || '').match(/(?:--tag|-t)\s+([^\s]+)/i);
  return m?.[1] || null;
}

function imageName(projectSlug) {
  return `${APP_IMAGE_PREFIX}${slug(projectSlug)}`;
}

function slug(value) {
  return String(value || 'app').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'app';
}

function dockerBlocked(st, reason) {
  return {
    status: 'blocked',
    reason: reason || (st.mode === 'safe' ? 'Docker SAFE mode is enabled.' : 'Docker socket is not available.'),
    docker: st,
  };
}

function clip(s) {
  return String(s || '').slice(0, 10000);
}

function execWithStdin(cmd, args, input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} timed out`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(stderr || stdout || `${cmd} exit ${code}`), { stdout, stderr }));
    });
    child.stdin.end(input);
  });
}
