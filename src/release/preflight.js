import fs from 'node:fs/promises';
import path from 'node:path';
import { writeSafeFile, listFiles } from '../utils/fsx.js';
import { detectContainerPort } from './solohost.js';
import { dockerfileForProject } from '../docker/runner.js';

/**
 * Prepare only deterministic SoloHost release files that are missing.
 * Existing application files are never overwritten here.
 */
export async function prepareReleaseContract({ sourceDir, owner, repo, version = '0.1.0', project = {} } = {}) {
  const changed = [];
  let files = await listFiles(sourceDir).catch(() => []);

  // A missing Dockerfile is safely repairable only when the project declares a
  // concrete Node start script. Do not invent a runtime for ambiguous projects.
  if (!files.includes('Dockerfile')) {
    const packageJson = JSON.parse(await fs.readFile(path.join(sourceDir, 'package.json'), 'utf8').catch(() => '{}'));
    if (packageJson?.scripts?.start) {
      await writeSafeFile(sourceDir, 'Dockerfile', dockerfileForProject({ packageJson }));
      changed.push('Dockerfile');
      files = [...files, 'Dockerfile'];
    }
  }

  const hasCompose = files.includes('docker-compose.yml') || files.includes('solohost/docker-compose.yml');

  if (!hasCompose) {
    const safeOwner = safePart(owner, 'OWNER');
    const safeRepo = safePart(repo || project.slug, 'app');
    const safeVersion = safePart(version, 'latest');
    const containerPort = Number(await detectContainerPort(sourceDir)) || 8080;
    const image = `ghcr.io/${safeOwner}/${safeRepo}:${safeVersion}`;
    const compose = `services:\n  app:\n    image: ${image}\n    restart: unless-stopped\n    labels:\n      pi.ui.primary: "true"\n    ports:\n      - "127.0.0.1:18080:${containerPort}"\n    environment:\n      - PORT=${containerPort}\n`;
    await writeSafeFile(sourceDir, 'docker-compose.yml', compose);
    changed.push('docker-compose.yml');
  }

  return {
    ok: true,
    changed,
    created: changed,
    notes: changed.length ? ['Created only the missing SoloHost compose contract.'] : [],
  };
}

function safePart(value, fallback) {
  const clean = String(value || '').trim().replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '');
  return clean || fallback;
}
