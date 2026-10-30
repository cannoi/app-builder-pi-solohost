import fs from 'node:fs/promises';
import path from 'node:path';
import { listFiles } from '../utils/fsx.js';
import { looksLikeSecret, maskSecrets } from '../utils/mask.js';
import { classifyCredentialSnippet, isBlockingSecurityFinding } from './classify.js';

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

  const blocking = findings.filter((f) => isBlockingSecurityFinding(f));
  const critical = blocking.length;
  const warning = findings.filter((f) => f.severity === 'warning' && !isBlockingSecurityFinding(f)).length;
  const notices = findings.filter((f) => f.severity === 'notice').length;

  const fixes = findings.map((f) => ({
    id: f.id,
    severity: f.severity,
    class: f.class || null,
    operationImpact: f.operationImpact || null,
    title: f.title,
    file: f.file,
    line: f.line || null,
    rootCause: f.rootCause,
    fix: f.fix,
    autoFix: Boolean(f.autoFix),
  }));

  // status BLOCK only when high-impact findings must stop public release
  const status = critical ? 'BLOCK' : warning ? 'WARNING' : notices ? 'NOTICE' : 'PASS';

  const copyForAi = buildSecurityReport({ critical, warning, notices, findings });
  return {
    status,
    critical,
    warning,
    notices,
    findings,
    fixes,
    summary: critical
      ? `${critical} high-impact security issue(s) must be fixed before public release.`
      : warning
        ? `${warning} security warning(s) — operation can continue; review recommended.`
        : notices
          ? `${notices} configuration notice(s) — user-defined values preserved.`
          : 'No blocking security issues detected.',
    copy_for_ai: copyForAi,
    // Explicit contract: notices/warnings do not fail the operation
    operationImpact: critical ? 'BLOCK_PUBLIC_RELEASE' : 'CONTINUE',
  };
}

function push(findings, item) {
  findings.push({
    id: item.id,
    severity: item.severity,
    class: item.class || null,
    operationImpact: item.operationImpact || null,
    check: item.check,
    file: item.file,
    line: item.line || null,
    title: item.title,
    detail: item.detail,
    rootCause: item.rootCause,
    fix: item.fix,
    autoFix: Boolean(item.autoFix),
  });
}

function scanFile(rel, text, findings) {
  if (rel === '.env' || rel.endsWith('/.env')) {
    push(findings, {
      id: 'secret-env-file',
      severity: 'critical',
      class: 'REAL_SECRET',
      operationImpact: 'BLOCK_PUBLIC_RELEASE',
      check: 'SECRET_SCAN',
      file: rel,
      title: 'Environment secret file is included in the app source.',
      detail: '.env files can contain API keys, passwords, tokens, or private configuration and must not be published.',
      rootCause: 'A runtime secret file is inside the project source tree.',
      fix: 'Remove the .env file from the project source, keep secrets in SoloHost configuration, and add .env to .gitignore.',
      autoFix: true,
    });
  }

  if (looksLikeSecret(text) || /\b(token|secret|password|api[_-]?key|HUB_ID|INGEST_TOKEN|PUBLIC_BASE_URL)\b/i.test(text)) {
    const classified = classifyCredentialSnippet({ text, file: rel });
    // Do not escalate USER_DEFINED / EXAMPLE / TEST to critical
    const severity = classified.severity === 'critical' && classified.operationImpact === 'BLOCK_PUBLIC_RELEASE'
      ? 'critical'
      : classified.severity;
    push(findings, {
      id: `secret-source:${rel}:${classified.class}`,
      severity,
      class: classified.class,
      operationImpact: classified.operationImpact,
      check: 'SECRET_SCAN',
      file: rel,
      title: classified.title,
      detail: maskSecrets(String(text).slice(0, 240)),
      rootCause: `Classified as ${classified.class} (confidence ${classified.confidence}).`,
      fix: classified.operationImpact === 'CONTINUE' || classified.operationImpact === 'CONTINUE_WITH_WARNING'
        ? 'No change required for this configuration value. Optionally move secrets to SoloHost config later.'
        : 'Move the credential to SoloHost configuration, remove the literal from source, and rotate if it was real.',
      autoFix: false,
    });
  }

  if (hasOperationalDockerSocket(rel, text)) {
    push(findings, {
      id: `docker-socket:${rel}`,
      severity: 'critical',
      class: 'DOCKER_SOCKET',
      operationImpact: 'BLOCK_PUBLIC_RELEASE',
      check: 'DOCKER_CHECK',
      file: rel,
      title: 'Docker socket access is present.',
      detail: 'The project references /var/run/docker.sock or docker.sock.',
      rootCause: 'The app is requesting host Docker daemon access.',
      fix: 'Remove the docker.sock mount/reference. Use the Builder Sandbox/Podman API or normal application APIs instead.',
      autoFix: true,
    });
  }

  if (/privileged:\s*true/.test(text)) {
    push(findings, {
      id: `privileged:${rel}`,
      severity: 'critical',
      class: 'PRIVILEGED',
      operationImpact: 'BLOCK_PUBLIC_RELEASE',
      check: 'DOCKER_CHECK',
      file: rel,
      title: 'Privileged container mode is enabled.',
      detail: 'The container requests privileged host-level capabilities.',
      rootCause: 'Compose configuration grants more host access than a normal app needs.',
      fix: 'Remove privileged: true.',
      autoFix: true,
    });
  }

  if (/0\.0\.0\.0:\d+/.test(text) && /docker-compose/.test(rel)) {
    push(findings, {
      id: `port-exposure:${rel}`,
      severity: 'warning',
      class: 'PUBLIC_CONFIGURATION',
      operationImpact: 'CONTINUE_WITH_WARNING',
      check: 'PORT_EXPOSURE',
      file: rel,
      title: 'Compose publishes a host port on all interfaces.',
      detail: 'A 0.0.0.0 host binding can expose the service beyond the intended local SoloHost routing.',
      rootCause: 'The host port is bound to every network interface.',
      fix: 'Prefer 127.0.0.1 for the host binding when SoloHost routing does not require direct exposure.',
      autoFix: true,
    });
  }

  if (/\beval\s*\(/.test(text) || (/\bchild_process\b/.test(text) && /\bexec\s*\(/.test(text))) {
    push(findings, {
      id: `dynamic-exec:${rel}`,
      severity: 'warning',
      class: 'SENSITIVE_CREDENTIAL',
      operationImpact: 'CONTINUE_WITH_WARNING',
      check: 'DANGEROUS_COMMANDS',
      file: rel,
      title: 'Dynamic command execution was detected.',
      detail: 'eval or child_process.exec can execute arbitrary commands.',
      rootCause: 'The code uses dynamic command execution.',
      fix: 'Avoid eval and unconstrained exec. Use explicit allow-listed operations.',
      autoFix: false,
    });
  }
}

function hasOperationalDockerSocket(rel, text) {
  if (!/docker\.sock|\/var\/run\/docker\.sock/.test(text)) return false;
  // Documentation-only mentions are not operational mounts
  if (/\.(md|txt)$/i.test(rel)) return false;
  if (/never mount|do not mount|do not use docker\.sock/i.test(text) && !/volumes:|binds:|- \/?var\/run\/docker\.sock/.test(text)) {
    return false;
  }
  return /volumes:|binds:|- ['"]?\/?var\/run\/docker\.sock|docker\.sock:/.test(text) || /\.ya?ml$/i.test(rel) || /\.js$/i.test(rel);
}

function buildSecurityReport({ critical, warning, notices, findings }) {
  const lines = ['APP BUILDER SECURITY REPORT'];
  lines.push(`blocking=${critical} warnings=${warning} notices=${notices || 0}`);
  for (const f of findings.slice(0, 40)) {
    lines.push(`- [${f.severity}/${f.class || 'n/a'}/${f.operationImpact || 'n/a'}] ${f.file}: ${f.title}`);
    if (f.rootCause) lines.push(`  ROOT_CAUSE: ${f.rootCause}`);
    if (f.fix) lines.push(`  FIX: ${f.fix}`);
  }
  return lines.join('\n');
}
