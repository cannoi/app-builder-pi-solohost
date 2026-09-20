import fs from 'node:fs/promises';
import path from 'node:path';
import { listFiles } from '../utils/fsx.js';
import { looksLikeSecret } from '../utils/mask.js';

const SKIP = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2']);

export async function scanProject(sourceDir) {
  const findings = [];
  const files = await listFiles(sourceDir);
  for (const rel of files) {
    const ext = path.extname(rel).toLowerCase();
    if (SKIP.has(ext)) continue;
    const full = path.join(sourceDir, rel);
    const text = await fs.readFile(full, 'utf8').catch(() => '');
    scanFile(rel, text, findings);
  }
  const critical = findings.filter((f) => f.severity === 'critical').length;
  const warning = findings.filter((f) => f.severity === 'warning').length;
  return {
    status: critical ? 'BLOCK' : warning ? 'WARNING' : 'PASS',
    critical,
    warning,
    findings,
  };
}

function scanFile(rel, text, findings) {
  if (rel === '.env' || rel.endsWith('/.env')) {
    findings.push({ severity: 'critical', check: 'SECRET_SCAN', file: rel, detail: '.env files must not be stored in the project snapshot.', fix: 'Remove .env from the publish source; keep operator secrets in SoloHost config or GitHub secrets.' });
  }
  if (looksLikeSecret(text)) {
    findings.push({ severity: 'critical', check: 'SECRET_SCAN', file: rel, detail: 'Possible secret or private key found in source.', fix: 'Remove the credential from source and rotate it if it was exposed.' });
  }
  if (/docker\.sock/.test(text)) {
    findings.push({ severity: 'critical', check: 'DOCKER_CHECK', file: rel, detail: 'Generated app references the Docker socket.', fix: 'Remove docker.sock access. Use the Builder sandbox API instead.' });
  }
  if (/privileged:\s*true/.test(text)) {
    findings.push({ severity: 'critical', check: 'DOCKER_CHECK', file: rel, detail: 'Privileged Docker mode requested.', fix: 'Remove privileged mode and use least-privilege container settings.' });
  }
  if (/0\.0\.0\.0:\d+/.test(text) && /docker-compose/.test(rel)) {
    findings.push({ severity: 'warning', check: 'PORT_EXPOSURE', file: rel, detail: 'Compose file publishes on all interfaces. Prefer 127.0.0.1.', fix: 'Bind the SoloHost UI port to 127.0.0.1.' });
  }
  if (/\beval\s*\(/.test(text) || /\bchild_process\b/.test(text) && /\bexec\s*\(/.test(text)) {
    findings.push({ severity: 'warning', check: 'DANGEROUS_COMMANDS', file: rel, detail: 'Dynamic execution detected. Review before release.', fix: 'Replace dynamic execution with a fixed allowlist or explicit function calls.' });
  }
  if (/\.\.\/\.\.\//.test(text) && /\bpath\b/.test(text)) {
    findings.push({ severity: 'warning', check: 'PATH_TRAVERSAL', file: rel, detail: 'Possible path traversal pattern.', fix: 'Validate and normalize user-controlled paths and reject traversal outside the intended directory.' });
  }
  if (rel === 'Dockerfile' && /USER root/.test(text) && !/USER /.test(text.replace('USER root', ''))) {
    findings.push({ severity: 'warning', check: 'DOCKER_CHECK', file: rel, detail: 'Container may run as root.', fix: 'Use a non-root USER in the Dockerfile when the application supports it.' });
  }
}
