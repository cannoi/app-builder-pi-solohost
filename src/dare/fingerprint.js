const BUILTIN = new Set([
  'assert', 'buffer', 'child_process', 'cluster', 'crypto', 'dgram', 'dns', 'events',
  'fs', 'http', 'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks',
  'process', 'punycode', 'querystring', 'readline', 'stream', 'string_decoder',
  'timers', 'tls', 'tty', 'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib',
]);

export function isBuiltinModule(name = '') {
  const n = String(name).replace(/^node:/, '').split('/')[0];
  return !n || n.startsWith('.') || BUILTIN.has(n);
}

export function fingerprintError(text = '') {
  const t = String(text || '');
  const moduleHit = t.match(/cannot find module ['"]([^'"]+)['"]/i)
    || t.match(/err_module_not_found[^A-Za-z0-9]+['"]?([^'"\s]+)['"]?/i)
    || t.match(/failed to resolve import ['"]([^'"]+)['"]/i)
    || t.match(/module not found:\s*['"]?([^'"\s]+)['"]?/i);
  if (moduleHit) {
    const pkg = String(moduleHit[1]).replace(/^node:/, '').split('/')[0];
    if (pkg && !pkg.startsWith('.') && !BUILTIN.has(pkg)) return `NODE_MODULE_MISSING:${pkg}`;
  }
  if (/lock file|lockfile|out of sync|npm ci.*package-lock/i.test(t)) return 'NPM_LOCKFILE_OUT_OF_SYNC';
  if (/missing script:\s*['"]?start['"]?/i.test(t)) return 'NPM_SCRIPT_MISSING:start';
  if (/eaddrinuse/i.test(t)) return 'DOCKER_PORT_NOT_LISTENING';
  if (/listen\(.*127\.0\.0\.1|listen\(.*'localhost'|listen\(.*"localhost"/i.test(t)) return 'DOCKER_LOCALHOST_BIND';
  if (/container exited before smoke|container did not become reachable/i.test(t)) return 'DOCKER_CONTAINER_CRASH';
  if (/permission_denied|insufficient_scope|packages: write|write:packages|403.*ghcr|denied.*ghcr/i.test(t)) return 'GHCR_PACKAGE_WRITE_PERMISSION';
  if (/unauthorized|authentication required|login failed/i.test(t) && /ghcr/i.test(t)) return 'GHCR_LOGIN_FAILED';
  if (/enoent|no such file or directory/i.test(t) && /copy failed|dockerfile/i.test(t)) return 'DOCKER_COPY_FAILED';
  if (/services:\s*$/m.test(t) || /compose.*invalid|yaml.*services/i.test(t)) return 'COMPOSE_INVALID';
  if (/sqlite|better-sqlite3/i.test(t) && /enoent|no such file|readonly|eacces/i.test(t)) return 'SQLITE_DIRECTORY_MISSING';
  if (/http 404|status code 404/i.test(t)) return 'HTTP_404';
  if (/http 5\d\d|status code 5/i.test(t)) return 'HTTP_5XX';
  if (/typeerror: cannot read propert/i.test(t)) return 'APP_LOGIC_UNKNOWN';
  return t.trim() ? 'UNKNOWN' : 'NONE';
}

export function classifyLayer(fp = '') {
  if (fp.startsWith('NODE_MODULE_MISSING') || fp === 'NPM_LOCKFILE_OUT_OF_SYNC' || fp.startsWith('NPM_SCRIPT_MISSING')) return 'DEPENDENCY_ERROR';
  if (fp.startsWith('GHCR') || fp === 'GH_ACTIONS_PERMISSION_MISSING') return 'GHCR_ERROR';
  if (fp.startsWith('DOCKER') || fp.startsWith('COMPOSE') || fp.startsWith('HTTP')) return 'CONTAINER_ERROR';
  if (fp === 'APP_LOGIC_UNKNOWN') return 'SOURCE_ERROR';
  if (fp === 'SQLITE_DIRECTORY_MISSING') return 'RUNTIME_ERROR';
  return 'UNKNOWN';
}
