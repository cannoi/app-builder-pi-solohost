/**
 * BuildRunner — native preview only (no container engine).
 *
 * Preview always goes through NativePreview (static / Node / Vite / Python / PHP / Go / Java).
 * Docker-only apps are reported honestly as `preview_limited` (preview has no Docker);
 * the final image is built by GitHub Actions / SoloHost on Publish.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { NativePreview } from '../runtime/native-preview.js';
import { PREVIEW_NOTICE } from '../runtime/preview-messages.js';

export class BuildRunner {
  constructor({ cfg, log, browserFactory = null } = {}) {
    this.cfg = cfg;
    this.log = log;
    this.browserFactory = browserFactory;
    this.native = new NativePreview({ cfg, log, browserFactory });
  }

  status() {
    return {
      engine: 'native-preview',
      mode: 'native',
      usable: true,
      dockerSocket: false,
      socketPresent: false,
      container: false,
      zeroConfig: true,
      active: this.native.listActive(),
      notice: PREVIEW_NOTICE,
      message: PREVIEW_NOTICE.en,
    };
  }

  async run(spec = {}) {
    return this.runApp({
      sourcePath: spec.sourcePath,
      projectSlug: spec.projectSlug,
      timeout: spec.timeout || this.cfg?.limits?.sandboxTimeoutSec,
      keepRunning: false,
    });
  }

  async runApp({ sourcePath, projectSlug, timeout = 180, keepRunning = true, acceptancePlan = null, captureImages = false, skipInternetProbe = false } = {}) {
    return this.native.run({ sourcePath, projectSlug, timeout, keepRunning, acceptancePlan, captureImages, skipInternetProbe });
  }

  async stopApp({ projectSlug } = {}) {
    return this.native.stop({ projectSlug });
  }

  async stopAllPreviews() {
    return this.native.stopAll();
  }

  async appStatus({ projectSlug } = {}) {
    return this.native.status({ projectSlug });
  }

  /** Images are built by GitHub Actions / SoloHost on Publish — never inside preview. */
  async buildImage() {
    return { status: 'skipped', engine: 'native-preview', reason: 'Docker images are built when you Publish (GitHub Actions / SoloHost). Preview does not use Docker.' };
  }

  async ensureBuildFiles(sourcePath, runtimeSpec = null) {
    const detectedFile = runtimeSpec?.kind === 'dockerfile' && runtimeSpec.file
      ? path.join(sourcePath, runtimeSpec.file)
      : path.join(sourcePath, 'Dockerfile');
    try {
      await fs.access(detectedFile);
      return { ok: true, created: false, path: detectedFile, contextPath: path.dirname(detectedFile), dockerfile: path.basename(detectedFile) };
    } catch { /* create below */ }
    let packageJson = null;
    try { packageJson = JSON.parse(await fs.readFile(path.join(sourcePath, 'package.json'), 'utf8')); } catch { /* */ }
    if (!packageJson) return { ok: false, created: false, error: 'Dockerfile is missing and no valid package.json is available to create one.' };
    const dockerfile = path.join(sourcePath, 'Dockerfile');
    await fs.writeFile(dockerfile, dockerfileForProject({ packageJson }), 'utf8');
    return { ok: true, created: true, path: dockerfile, contextPath: sourcePath, dockerfile: 'Dockerfile' };
  }

  async execSandbox() {
    return { status: 'blocked', runtime: 'native-preview', error: 'Raw shell commands are disabled. Use Build, Run, Check, or Improve.' };
  }

  // Container inspection APIs are not available in preview.
  async listContainers() { return { status: 'passed', engine: 'native-preview', items: [] }; }
  async inspectContainer() { return { status: 'blocked', engine: 'native-preview', error: 'Preview does not use containers.' }; }
  async logs() { return ''; }
  async imageInfo() { return { status: 'blocked', engine: 'native-preview', error: 'Preview does not use container images.' }; }
  async imageHistory() { return { status: 'blocked', engine: 'native-preview', items: [] }; }
  async exportImage() { return { status: 'blocked', error: 'Image export is not available in preview.' }; }
  async exportContainer() { return { status: 'blocked', error: 'Container import/export is not available in preview.' }; }
  async pushImage() { return { status: 'skipped', reason: 'Final GHCR publication is handled by GitHub Actions.' }; }
  async verifyImage() { return { ok: false, error: 'Preview does not build images.' }; }
}

export function dockerfileForProject({ packageJson }) {
  const start = String(packageJson?.scripts?.start || '').trim();
  const command = start === 'node src/server.js' ? ['node', 'src/server.js'] : start ? ['sh', '-lc', start] : ['node', String(packageJson?.main || 'src/server.js')];
  return `FROM node:24-alpine\nWORKDIR /app\n\nCOPY package*.json ./\nRUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi\nCOPY . .\n\nENV PORT=8080\nENV BIND=0.0.0.0\nEXPOSE 8080\n\nLABEL org.opencontainers.image.source="https://github.com/cannoi/app-builder-pi-solohost"\n\nHEALTHCHECK --interval=20s --timeout=5s --start-period=10s --retries=3 \\\n  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"\n\nCMD ${JSON.stringify(command)}\n`;
}
