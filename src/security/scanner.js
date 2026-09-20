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
  const fixes = findings.map((f) => ({
    id: f.id,
    severity: f.severity,
    title: f.title,
    file: f.file,
    line: f.line || null,
    rootCause: f.rootCause,
    fix: f.fix,
    autoFix: Boolean(f.autoFix),
  }));
  const copyForAi = buildSecurityReport({ critical, warning, findings });
  return {
    status: critical ? 'BLOCK' : warning ? 'WARNING' : 'PASS',
    critical,
    warning,
    findings,
    fixes,
    summary: critical
      ? `${critical} blocking security issue(s) must be fixed before release.`
      : warning
        ? `${warning} security warning(s) require review before release.`
        : 'No blocking security issues detected.',
    copy_for_ai: copyForAi,
  };
}

function push(findings, item) {
  findings.push({
    id: item.id,
    severity: item.severity,
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
      id: 'secret-env-file', severity: 'critical', check: 'SECRET_SCAN', file: rel,
      title: 'Environment secret file is included in the app source.',
      detail: '.env files can contain API keys, passwords, tokens, or private configuration and must not be published.',
      rootCause: 'A runtime secret file is inside the project source tree.',
      fix: 'Remove the .env file from the project source, keep secrets in SoloHost configuration, and add .env to .gitignore.',
      autoFix: true,
    });
  }
  if (looksLikeSecret(text)) {
    push(findings, {
      id: `secret-source:${rel}`, severity: 'critical', check: 'SECRET_SCAN', file: rel,
      title: 'Possible secret or private key is embedded in source.',
      detail: 'A value in this file matches a secret/private-key pattern.',
      rootCause: 'A credential appears to be hard-coded instead of supplied at runtime.',
      fix: 'Move the credential to a password field in config_options.yml/Secret settings, read it from the environment, and remove the literal from source. Rotate the exposed credential if it was real.',
      autoFix: false,
    });
  }
  if (/docker\.sock/.test(text)) {
    push(findings, {
      id: `docker-socket:${rel}`, severity: 'critical', check: 'DOCKER_CHECK', file: rel,
      title: 'Docker socket access is present.',
      detail: 'The project references /var/run/docker.sock or docker.sock.',
      rootCause: 'The app is requesting host Docker daemon access.',
      fix: 'Remove the docker.sock mount/reference. Use the Builder Sandbox/Podman API or normal application APIs instead. Never expose the host Docker socket to generated apps.',
      autoFix: true,
    });
  }
  if (/privileged:\s*true/.test(text)) {
    push(findings, {
      id: `privileged:${rel}`, severity: 'critical', check: 'DOCKER_CHECK', file: rel,
      title: 'Privileged container mode is enabled.',
      detail: 'The container requests privileged host-level capabilities.',
      rootCause: 'Compose configuration grants more host access than a normal app needs.',
      fix: 'Remove privileged: true. Use the minimum required capabilities and normal network/storage access.',
      autoFix: true,
    });
  }
  if (/0\.0\.0\.0:\d+/.test(text) && /docker-compose/.test(rel)) {
    push(findings, {
      id: `port-exposure:${rel}`, severity: 'warning', check: 'PORT_EXPOSURE', file: rel,
      title: 'Compose publishes a host port on all interfaces.',
      detail: 'A 0.0.0.0 host binding can expose the service beyond the intended local SoloHost routing.',
      rootCause: 'The host port is bound to every network interface.',
      fix: 'Prefer 127.0.0.1 for the host binding when SoloHost routing does not require direct LAN/WAN exposure.',
      autoFix: true,
    });
  }
  if (/\beval\s*\(/.test(text) || /\bchild_process\b/.test(text) && /\bexec\s*\(/.test(text)) {
    push(findings, {
      id: `dynamic-exec:${rel}`, severity: 'warning', check: 'DANGEROUS_COMMANDS', file: rel,
      title: 'Dynamic command execution was detected.',
      detail: 'eval() or child_process.exec() can turn untrusted input into code or shell commands.',
      rootCause: 'The application uses a high-risk dynamic execution primitive.',
      fix: 'Prefer fixed command allowlists and execFile with fixed argument arrays. Validate all user-controlled input before any process operation.',
      autoFix: false,
    });
  }
  if (/\.\.\/\.\.\//.test(text) && /\bpath\b/.test(text)) {
    push(findings, {
      id: `path-traversal:${rel}`, severity: 'warning', check: 'PATH_TRAVERSAL', file: rel,
      title: 'A possible path traversal pattern was detected.',
      detail: 'Relative path segments are used in code that also handles paths.',
      rootCause: 'User-controlled or insufficiently validated path input may escape the intended directory.',
      fix: 'Resolve against a fixed base directory, normalize the path, and reject values that escape the base directory before reading or writing files.',
      autoFix: false,
    });
  }
  if (rel === 'Dockerfile' && /USER root/.test(text) && !/USER /.test(text.replace('USER root', ''))) {
    push(findings, {
      id: 'docker-root', severity: 'warning', check: 'DOCKER_CHECK', file: rel,
      title: 'The Docker image runs as root.',
      detail: 'The Dockerfile does not switch to a non-root user after declaring USER root.',
      rootCause: 'The application process may have unnecessary root privileges inside the container.',
      fix: 'Create/use a non-root application user and switch to it before CMD/ENTRYPOINT unless root is demonstrably required.',
      autoFix: false,
    });
  }
}

function buildSecurityReport({ critical, warning, findings }) {
  const lines = [
    'APP BUILDER SECURITY REPORT',
    `STATUS: ${critical ? 'BLOCK' : warning ? 'WARNING' : 'PASS'}`,
    `CRITICAL: ${critical}`,
    `WARNING: ${warning}`,
  ];
  for (const [i, f] of findings.slice(0, 20).entries()) {
    lines.push('', `ISSUE ${i + 1}: ${f.title}`, `SEVERITY: ${f.severity.toUpperCase()}`, `FILE: ${f.file}${f.line ? `:${f.line}` : ''}`, `ROOT_CAUSE: ${f.rootCause}`, `FIX: ${f.fix}`, `AUTO_FIX: ${f.autoFix ? 'SAFE AUTOMATIC FIX MAY BE APPLIED' : 'AI/USER REVIEW REQUIRED'}`);
  }
  lines.push('', 'REPAIR RULE: Preserve the existing app. Apply the smallest targeted security patch. Do not rewrite unrelated features. Re-scan and re-test after every repair.');
  return lines.join('\n');
}
