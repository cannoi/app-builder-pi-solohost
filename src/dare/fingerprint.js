import { builtinModules, isBuiltin } from 'node:module';

const BUILTIN = new Set(builtinModules.map((name) => name.replace(/^node:/, '').split('/')[0]));

export function isBuiltinModule(name = '') {
  const value = String(name).trim();
  if (!value || value.startsWith('.') || value.startsWith('#')) return true;
  if (isBuiltin(value)) return true;
  const root = value.replace(/^node:/, '').split('/')[0];
  return BUILTIN.has(root);
}

export function fingerprintError(text = '') {
  const t = String(text || '');
  const moduleHit = t.match(/cannot find module ['"]([^'"]+)['"]/i)
    || t.match(/err_module_not_found[^A-Za-z0-9]+['"]?([^'"\s]+)['"]?/i)
    || t.match(/failed to resolve import ['"]([^'"]+)['"]/i)
    || t.match(/module not found:\s*['"]?([^'"\s]+)['"]?/i);

  if (moduleHit) {
    const specifier = String(moduleHit[1]).trim();
    const root = specifier.startsWith('@')
      ? specifier.split('/').slice(0, 2).join('/')
      : specifier.split('/')[0];
    if (root && !isBuiltinModule(root)) return `NODE_MODULE_MISSING:${root}`;
  }

  if (/lock file|lockfile|out of sync|npm ci.*package-lock/i.test(t)) return 'NPM_LOCKFILE_OUT_OF_SYNC';
  if (/missing script:\s*['"]?start['"]?/i.test(t)) return 'NPM_SCRIPT_MISSING:start';
  if (/eaddrinuse|address already in use/i.test(t)) return 'DOCKER_PORT_NOT_LISTENING';
  if (/\.listen\s*\([^)]*(['"]127\.0\.0\.1['"]|['"]localhost['"])\s*\)/i.test(t)
      || /listen.*(?:127\.0\.0\.1|localhost)/i.test(t)) return 'DOCKER_LOCALHOST_BIND';

  if (/permission denied.*(?:packages|ghcr)|insufficient_scope.*ghcr|403.*ghcr|denied.*(?:write|push).*ghcr|write:packages/i.test(t)) {
    return 'GHCR_PACKAGE_WRITE_PERMISSION';
  }
  if (/(?:unauthorized|authentication required|login failed|denied)/i.test(t) && /ghcr/i.test(t)) return 'GHCR_LOGIN_FAILED';

  if (/services:\s*$/m.test(t) || /compose.*invalid|yaml.*services|services.*must be.*object/i.test(t)) return 'COMPOSE_INVALID';
  if (/services.*(?:empty|non-empty object)/i.test(t)) return 'COMPOSE_SERVICES_EMPTY';

  if (/copy failed|dockerfile.*(?:no such file|not found)|no such file.*(?:dockerfile|context)/i.test(t)) {
    return 'DOCKER_COPY_FAILED';
  }
  if (/EACCES[^\n]*(?:mkdir|permission denied)[^\n]*['\"]([^'\"]+)['\"]/i.test(t)
      || /(?:permission denied|EACCES)[^\n]*mkdir/i.test(t)) {
    const hit = t.match(/mkdir[^'\"]*['\"]([^'\"]+)['\"]/i);
    const target = String(hit?.[1] || '').trim();
    return target ? `RUNTIME_FILESYSTEM_PERMISSION:${target}` : 'RUNTIME_FILESYSTEM_PERMISSION';
  }
  if (/container exited before smoke|container did not become reachable|process died before.*listen/i.test(t)) return 'DOCKER_CONTAINER_CRASH';
  if (/not listening|connection refused.*(?:port|localhost)|port.*(?:not reachable|unreachable)/i.test(t)) return 'DOCKER_PORT_NOT_LISTENING';

  if (/(?:node-gyp|gyp ERR!|invalid ELF header|Could not locate the bindings file|was compiled against a different Node\.js version|native.*(?:compil|rebuild) fail)/i.test(t)
      && /(?:sqlite3|better-sqlite3|bcrypt|sharp|canvas)/i.test(t)) {
    return 'NATIVE_DEPENDENCY_BUILD_FAILURE';
  }
  if (/sqlite|better-sqlite3/i.test(t) && /(?:enoent|no such file|cannot open|database.*not found|sqlite_cantopen.*unable to open database file)/i.test(t)) return 'SQLITE_DIRECTORY_MISSING';
  if (/sqlite|better-sqlite3/i.test(t) && /(?:readonly|read-only|eacces|permission denied)/i.test(t)) return 'SQLITE_WRITE_PERMISSION';

  if (/node(?:\.js)?\s+version|unsupported engine|requires node|engine.*node/i.test(t)) return 'NODE_ENGINE_MISMATCH';
  if (/\b(?:ERR_REQUIRE_ESM|require\(\).*ES module|module.*commonjs|cannot use import statement outside a module)\b/i.test(t)) return 'NODE_ESM_CJS_MISMATCH';

  if (/http 404|status code 404/i.test(t)) return 'HTTP_404';
  if (/http 5\d\d|status code 5/i.test(t)) return 'HTTP_5XX';
  if (/not ready|health check.*fail|health.*unavailable/i.test(t)) return 'HTTP_NOT_READY';
  if (/typeerror: cannot read propert/i.test(t)) return 'APP_LOGIC_UNKNOWN';

  return t.trim() ? 'UNKNOWN' : 'NONE';
}

export function classifyLayer(fp = '') {
  if (fp.startsWith('NODE_MODULE_MISSING') || fp === 'NATIVE_DEPENDENCY_BUILD_FAILURE' || fp === 'NPM_LOCKFILE_OUT_OF_SYNC' || fp.startsWith('NPM_SCRIPT_MISSING')) return 'DEPENDENCY_ERROR';
  if (fp.startsWith('GHCR') || fp === 'GH_ACTIONS_PERMISSION_MISSING') return 'GHCR_ERROR';
  if (fp.startsWith('DOCKER') || fp.startsWith('COMPOSE') || fp.startsWith('HTTP')) return 'CONTAINER_ERROR';
  if (fp.startsWith('SQLITE') || fp.startsWith('RUNTIME_FILESYSTEM_PERMISSION')) return 'RUNTIME_ERROR';
  if (fp === 'APP_LOGIC_UNKNOWN') return 'SOURCE_ERROR';
  return 'UNKNOWN';
}
