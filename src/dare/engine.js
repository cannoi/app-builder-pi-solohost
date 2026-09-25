import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fingerprintError, classifyLayer, isBuiltinModule } from './fingerprint.js';
import { ensureMissingDependencies, findMissingNodeModules } from '../projects/deps-fix.js';
import { listFiles } from '../utils/fsx.js';

const execFileAsync = promisify(execFile);
const MAX_ATTEMPTS_PER_FINGERPRINT = 1;

export async function runDare({ sourceDir, logs = '', extra = {}, history = [] } = {}) {
  const before = await fileManifest(sourceDir);
  const extraText = extra && typeof extra === 'object' ? (extra.message || extra.title || extra.hint || extra.code || '') : '';
  const fp = fingerprintError(`${logs}\n${extraText}`);
  const layer = classifyLayer(fp);
  const previous = Array.isArray(history) ? history : [];
  const sourceHash = manifestHash(before);
  const attempted = previous.filter((h) => h.fingerprint === fp && h.sourceHash === sourceHash);
  const priorRule = attempted[0]?.ruleId || null;

  if (attempted.length >= MAX_ATTEMPTS_PER_FINGERPRINT) {
    return report({
      ok: false, stopped: true, fingerprint: fp, layer,
      reason: 'Loop protection stopped another automatic repair of the same error.',
      next: fp === 'GHCR_PACKAGE_WRITE_PERMISSION' || fp === 'GHCR_LOGIN_FAILED' ? 'USER_ACTION' : 'AI',
      history: previous,
      before,
      sourceHash,
      priorRule,
    });
  }

  let action = await matchRule(sourceDir, fp, logs);

  // A generic/unknown runtime error still gets one deterministic preflight scan.
  if (!action && fp === 'UNKNOWN' && /module|import|require|missing script|localhost|ghcr|compose/i.test(`${logs}\n${extraText}`)) {
    action = await preflightScan(sourceDir);
  }

  if (!action) {
    return report({
      ok: false, fingerprint: fp, layer,
      reason: 'DARE has no safe deterministic rule for this fingerprint.',
      next: layer === 'GHCR_ERROR' ? 'USER_ACTION' : 'AI',
      history: previous,
      before,
    });
  }

  if (action.risk === 'UNSAFE') {
    return report({ ok: false, fingerprint: fp, layer, reason: action.reason, next: action.next || 'USER_ACTION', history: previous, before });
  }

  const result = await applyAction(sourceDir, { ...action, fingerprint: fp, layer }, previous);
  const after = await fileManifest(sourceDir);
  const changed = diffManifest(before, after);

  // Never claim a repair when the file set changed outside the declared patch.
  const declared = new Set((result.files || []).map(normalizeFile));
  const unexpected = changed.filter((file) => !declared.has(normalizeFile(file)));
  if (unexpected.length) {
    return report({
      ok: false, fingerprint: fp, layer,
      reason: `DARE detected unexpected file changes: ${unexpected.slice(0, 10).join(', ')}`,
      next: 'AI', history: previous, before, after, changed, unexpected,
    });
  }

  return report({ ...result, before, after, changed, history: previous, sourceHash });
}

async function preflightScan(sourceDir) {
  const deps = await findMissingNodeModules(sourceDir).catch(() => ({ missing: [] }));
  if (deps.missing?.length) {
    return {
      ruleId: 'NODE_MODULE_MISSING',
      fingerprint: `NODE_MODULE_MISSING:${deps.missing[0]}`,
      layer: 'DEPENDENCY_ERROR',
      risk: 'SAFE',
      reason: `Missing dependency: ${deps.missing.join(', ')}`,
      repair: 'deps',
    };
  }
  const start = await missingStartScript(sourceDir);
  if (start) return start;
  const bind = await localhostBind(sourceDir);
  if (bind) return bind;
  const wf = await workflowPackagesWrite(sourceDir);
  if (wf) return wf;
  return null;
}

async function matchRule(sourceDir, fp, logs) {
  if (fp.startsWith('NODE_MODULE_MISSING:')) {
    return { ruleId: 'NODE_MODULE_MISSING', risk: 'SAFE', repair: 'deps', reason: `Missing dependency: ${fp.slice('NODE_MODULE_MISSING:'.length)}` };
  }
  if (fp === 'NPM_SCRIPT_MISSING:start') return missingStartScript(sourceDir);
  if (fp === 'DOCKER_LOCALHOST_BIND') return localhostBind(sourceDir);
  if (fp === 'SQLITE_DIRECTORY_MISSING') return sqliteDirectoryRepair(sourceDir, logs);
  if (fp === 'SQLITE_WRITE_PERMISSION') return { ruleId: 'SQLITE_WRITE_PERMISSION', risk: 'UNSAFE', reason: 'SQLite is present but the database path is not writable. Builder will not change permissions automatically.', next: 'USER_ACTION' };
  if (fp.startsWith('RUNTIME_FILESYSTEM_PERMISSION')) return await runtimeFilesystemPermissionRepair(sourceDir, fp, logs);
  if (fp === 'GHCR_PACKAGE_WRITE_PERMISSION') {
    const wf = await workflowPackagesWrite(sourceDir);
    return wf || { ruleId: 'GHCR_PACKAGE_WRITE_PERMISSION', risk: 'UNSAFE', reason: 'GitHub account/repository does not allow package publishing. Builder will not change account permissions.', next: 'USER_ACTION' };
  }
  if (fp === 'DOCKER_CONTAINER_CRASH' && /cannot find module|module not found/i.test(logs)) {
    return { ruleId: 'NODE_MODULE_MISSING', risk: 'SAFE', repair: 'deps', reason: 'Container crashed because a Node package is missing.' };
  }
  if (fp === 'NODE_ENGINE_MISMATCH') {
    return await nodeEngineRepair(sourceDir, logs);
  }
  if (fp === 'NPM_LOCKFILE_OUT_OF_SYNC') {
    return { ruleId: 'NPM_LOCKFILE_OUT_OF_SYNC', risk: 'MEDIUM', repair: 'lockfile', reason: 'The package manifest and lockfile are out of sync.' };
  }
  return null;
}

async function applyAction(sourceDir, action, history) {
  if (action.repair === 'deps') {
    const packageName = action.fingerprint?.startsWith('NODE_MODULE_MISSING:') ? action.fingerprint.slice('NODE_MODULE_MISSING:'.length) : '';
    const result = await ensureMissingDependencies(sourceDir, packageName);
    if (!result.changed) {
      return report({ ok: false, fingerprint: action.fingerprint, layer: action.layer || 'DEPENDENCY_ERROR', reason: 'Dependencies already match source imports.', next: 'AI', history });
    }
    return report({
      ok: true, fingerprint: action.fingerprint || `NODE_MODULE_MISSING:${(result.added || []).join(',')}`,
      layer: 'DEPENDENCY_ERROR', ruleId: 'NODE_MODULE_MISSING',
      files: ['package.json'], added: result.added,
      reason: `Added ${result.added.join(', ')} to package.json. The project package manager will resolve the lockfile during the next build.`,
      next: 'CONTINUE', history,
    });
  }

  if (action.repair === 'node-engine' && action.file && action.nodeMajor) {
    await patchNodeEngine(action.file, sourceDir, action.nodeMajor);
    return report({
      ok: true, fingerprint: 'NODE_ENGINE_MISMATCH', layer: 'DEPENDENCY_ERROR',
      ruleId: 'NODE_ENGINE_MISMATCH', files: [action.file],
      reason: `Updated the Docker Node base to Node ${action.nodeMajor}, matching the project's minimum engine.`,
      next: 'CONTINUE', history,
    });
  }

  if (action.repair === 'lockfile') {
    const result = await refreshLockfile(sourceDir);
    if (!result.ok) {
      return report({ ok: false, fingerprint: 'NPM_LOCKFILE_OUT_OF_SYNC', layer: 'DEPENDENCY_ERROR', ruleId: 'NPM_LOCKFILE_OUT_OF_SYNC', reason: result.reason, next: 'AI', history });
    }
    return report({
      ok: true, fingerprint: 'NPM_LOCKFILE_OUT_OF_SYNC', layer: 'DEPENDENCY_ERROR',
      ruleId: 'NPM_LOCKFILE_OUT_OF_SYNC', files: [result.lockfile],
      reason: `Refreshed ${result.lockfile} without running project scripts.`,
      next: 'CONTINUE', history,
    });
  }

  if (action.repair === 'start-script' && action.start) {
    await patchPackageStart(sourceDir, action.start);
    return report({ ok: true, fingerprint: 'NPM_SCRIPT_MISSING:start', layer: 'DEPENDENCY_ERROR', ruleId: 'NPM_SCRIPT_MISSING', files: ['package.json'], reason: `Added start script: ${action.start}`, next: 'CONTINUE', history });
  }

  if (action.repair === 'bind-all' && action.file) {
    await patchListenBind(path.join(sourceDir, action.file));
    return report({ ok: true, fingerprint: 'DOCKER_LOCALHOST_BIND', layer: 'CONTAINER_ERROR', ruleId: 'DOCKER_LOCALHOST_BIND', files: [action.file], reason: 'HTTP server now listens on 0.0.0.0 so the container can be reached.', next: 'CONTINUE', history });
  }

  if (action.repair === 'sqlite-dir' && action.dir) {
    await fs.mkdir(path.join(sourceDir, action.dir), { recursive: true });
    return report({ ok: true, fingerprint: 'SQLITE_DIRECTORY_MISSING', layer: 'RUNTIME_ERROR', ruleId: 'SQLITE_DIRECTORY_MISSING', files: [`${action.dir}/`], reason: `Created the missing SQLite directory ${action.dir}/.`, next: 'CONTINUE', history });
  }

  if (action.repair === 'workflow-packages') {
    const file = await ensureWorkflowPackagesWrite(sourceDir);
    return report({ ok: true, fingerprint: 'GHCR_PACKAGE_WRITE_PERMISSION', layer: 'GHCR_ERROR', ruleId: 'GH_ACTIONS_PERMISSION_MISSING', files: [file], reason: 'Added only packages: write to the image workflow.', next: 'CONTINUE', history });
  }

  if (action.repair === 'filesystem-permission' && action.dockerfile && action.path && action.user) {
    const file = await patchDockerfileRuntimeDirectory(sourceDir, action.dockerfile, action.path, action.user);
    return report({
      ok: true, fingerprint: action.fingerprint || `RUNTIME_FILESYSTEM_PERMISSION:${action.path}`, layer: 'RUNTIME_ERROR',
      ruleId: 'RUNTIME_FILESYSTEM_PERMISSION', files: [file],
      reason: `Made the runtime directory ${action.path} writable by the image user ${action.user} without changing application code.`,
      next: 'CONTINUE', history,
    });
  }

  return report({ ok: false, fingerprint: action.fingerprint || 'UNKNOWN', layer: action.layer || 'UNKNOWN', reason: 'Rule matched but produced no verified patch.', next: 'AI', history });
}

async function refreshLockfile(sourceDir) {
  const commands = [
    ['pnpm-lock.yaml', 'pnpm', ['install', '--lockfile-only', '--ignore-scripts']],
    ['yarn.lock', 'yarn', ['install', '--mode=skip-builds']],
    ['bun.lock', 'bun', ['install', '--lockfile-only']],
    ['bun.lockb', 'bun', ['install', '--lockfile-only']],
    ['package-lock.json', 'npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund']],
  ];
  for (const [lockfile, command, args] of commands) {
    try {
      await fs.access(path.join(sourceDir, lockfile));
      await execFileAsync(command, args, { cwd: sourceDir, timeout: 120000, maxBuffer: 1024 * 1024 * 4 });
      return { ok: true, lockfile };
    } catch (err) {
      if (String(err.code || '') === 'ENOENT') continue;
      return { ok: false, reason: `${command} could not refresh ${lockfile}: ${String(err.message || err).slice(0, 300)}` };
    }
  }
  return { ok: false, reason: 'No supported lockfile was found.' };
}

async function nodeEngineRepair(sourceDir, logs = '') {
  const pkg = JSON.parse(await fs.readFile(path.join(sourceDir, 'package.json'), 'utf8').catch(() => '{}'));
  const range = String(pkg.engines?.node || '');
  const min = range.match(/(?:>=|>|~|\^)?\s*(\d+)/);
  if (!min) return null;
  const minMajor = Number(min[1]);
  if (!Number.isFinite(minMajor)) return null;

  const dfPath = path.join(sourceDir, 'Dockerfile');
  const df = await fs.readFile(dfPath, 'utf8').catch(() => '');
  const from = df.match(/^FROM\s+node:(\d+)([^\s]*)/mi);
  if (!from) return null;
  const currentMajor = Number(from[1]);
  if (!Number.isFinite(currentMajor) || currentMajor >= minMajor) return null;
  if (!/node(?:\.js)?\s+version|unsupported engine|requires node|engine.*node/i.test(logs)) return null;

  return {
    ruleId: 'NODE_ENGINE_MISMATCH',
    fingerprint: 'NODE_ENGINE_MISMATCH',
    layer: 'DEPENDENCY_ERROR',
    risk: 'MEDIUM',
    repair: 'node-engine',
    file: 'Dockerfile',
    nodeMajor: minMajor,
    reason: `Dockerfile uses Node ${currentMajor}, while package.json requires Node ${minMajor}+.`,
  };
}

async function patchNodeEngine(file, sourceDir, major) {
  const full = path.join(sourceDir, file);
  const text = await fs.readFile(full, 'utf8');
  const next = text.replace(/^(FROM\s+node:)\d+(\S*)/mi, `$1${major}$2`);
  if (next === text) throw new Error('The expected Node Docker base image was not found.');
  await fs.writeFile(full, next);
}

async function missingStartScript(sourceDir) {
  const pkgPath = path.join(sourceDir, 'package.json');
  const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8').catch(() => 'null'));
  if (!pkg || pkg.scripts?.start) return null;
  const present = [];
  for (const name of ['server.js', 'index.js', 'app.js']) {
    try { await fs.access(path.join(sourceDir, name)); present.push(name); } catch {}
  }
  if (present.length !== 1) return null;
  return { ruleId: 'NPM_SCRIPT_MISSING', fingerprint: 'NPM_SCRIPT_MISSING:start', layer: 'DEPENDENCY_ERROR', risk: 'SAFE', repair: 'start-script', start: `node ${present[0]}`, reason: `Missing start script; unique entry is ${present[0]}.` };
}

async function localhostBind(sourceDir) {
  const files = await listFiles(sourceDir);
  for (const rel of files) {
    if (!/\.(js|mjs|cjs|jsx|ts|tsx)$/.test(rel) || rel.startsWith('node_modules/')) continue;
    const text = await fs.readFile(path.join(sourceDir, rel), 'utf8').catch(() => '');
    if (/\.listen\s*\([^)]*(['"]127\.0\.0\.1['"]|['"]localhost['"])/.test(text)) {
      return { ruleId: 'DOCKER_LOCALHOST_BIND', fingerprint: 'DOCKER_LOCALHOST_BIND', layer: 'CONTAINER_ERROR', risk: 'MEDIUM', repair: 'bind-all', file: rel, reason: `${rel} binds the HTTP server to localhost.` };
    }
  }
  return null;
}

async function runtimeFilesystemPermissionRepair(sourceDir, fp, logs = '') {
  const rawPath = fp.startsWith('RUNTIME_FILESYSTEM_PERMISSION:')
    ? fp.slice('RUNTIME_FILESYSTEM_PERMISSION:'.length).trim()
    : String(String(logs).match(/(?:mkdir|open|write|rename|unlink)[^'\"]*['\"]([^'\"]+)['\"]/i)?.[1] || '').trim();
  if (!rawPath || !rawPath.startsWith('/')) return null;

  const dfPath = path.join(sourceDir, 'Dockerfile');
  const df = await fs.readFile(dfPath, 'utf8').catch(() => '');
  if (!df) return null;

  const workdir = df.match(/^WORKDIR\s+([^\s#]+)/mi)?.[1] || '/app';
  const userMatches = [...df.matchAll(/^USER\s+([^\s#]+)/gmi)];
  const runtimeUser = userMatches.length ? userMatches[userMatches.length - 1][1] : '';
  if (!runtimeUser || /^(0|root)$/i.test(runtimeUser)) return null;

  const normalizedWorkdir = path.posix.normalize(workdir);
  const normalizedTarget = path.posix.normalize(rawPath);
  const underWorkdir = normalizedTarget === normalizedWorkdir || normalizedTarget.startsWith(`${normalizedWorkdir.replace(/\/$/, '')}/`);
  if (!underWorkdir) return null;

  // Only repair the concrete runtime directory implicated by mkdir/open/write.
  // Do not chmod the whole app, and do not modify source code.
  return {
    ruleId: 'RUNTIME_FILESYSTEM_PERMISSION',
    fingerprint: fp,
    layer: 'RUNTIME_ERROR',
    risk: 'SAFE',
    repair: 'filesystem-permission',
    dockerfile: 'Dockerfile',
    path: normalizedTarget,
    user: runtimeUser,
    reason: `The image runs as ${runtimeUser}, but ${normalizedTarget} is not writable by that user.`,
  };
}

async function patchDockerfileRuntimeDirectory(sourceDir, file, targetPath, user) {
  const full = path.join(sourceDir, file);
  const text = await fs.readFile(full, 'utf8');
  const escapedPath = String(targetPath).replace(/'/g, "'\"'\"'");
  const marker = new RegExp(`^USER\\s+${user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'mi');
  if (!marker.test(text)) throw new Error('The expected runtime USER instruction was not found.');
  const block = `RUN mkdir -p '${escapedPath}' && chown '${user}' '${escapedPath}'\n`;
  const escapedTarget = String(targetPath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hasMkdir = new RegExp(`RUN\\s+mkdir\\s+-p\\s+['\"]?${escapedTarget}`, 'i').test(text);
  const escapedUser = String(user).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hasChown = new RegExp(`chown\\s+['\"]?${escapedUser}['\"]?\\s+['\"]?${escapedTarget}`, 'i').test(text);
  if (hasMkdir && hasChown) return file;
  const next = text.replace(marker, `${block}USER ${user}`);
  if (next === text) throw new Error('Dockerfile runtime permission patch was not applied.');
  await fs.writeFile(full, next);
  return file;
}

async function sqliteDirectoryRepair(sourceDir, logs = '') {
  const candidates = new Set();
  const pathMatches = String(logs).matchAll(/(?:ENOENT|no such file|cannot open)[^'\n]*['"]?((?:\.\/|\.\.\/|\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+)/ig);
  for (const match of pathMatches) {
    const raw = String(match[1] || '').replace(/^(\.\/)+/, '');
    const dir = path.posix.dirname(raw);
    if (dir && dir !== '.') candidates.add(dir);
  }

  // If the source explicitly uses a data directory for SQLite, that is a
  // deterministic signal. Do not create unrelated upload/cache directories.
  const files = await listFiles(sourceDir);
  for (const rel of files.filter((f) => /\.(js|mjs|cjs|ts|tsx|jsx)$/.test(f))) {
    const text = await fs.readFile(path.join(sourceDir, rel), 'utf8').catch(() => '');
    if (/(?:sqlite|better-sqlite3)/i.test(text)) {
      for (const m of text.matchAll(/(?:['"`])(\.?\.?\/)?(data(?:\/[^'"`]+)?)/g)) {
        candidates.add(path.posix.dirname(m[2]));
      }
    }
  }
  const dirs = [...candidates].filter((d) => d && d !== '.');
  if (dirs.length !== 1) return null;
  return { ruleId: 'SQLITE_DIRECTORY_MISSING', fingerprint: 'SQLITE_DIRECTORY_MISSING', layer: 'RUNTIME_ERROR', risk: 'SAFE', repair: 'sqlite-dir', dir: dirs[0], reason: `The SQLite path identifies ${dirs[0]}/ as the only missing data directory.` };
}

async function patchPackageStart(sourceDir, start) {
  const pkgPath = path.join(sourceDir, 'package.json');
  const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
  pkg.scripts = { ...(pkg.scripts || {}), start };
  await fs.writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

async function patchListenBind(full) {
  let text = await fs.readFile(full, 'utf8');
  const next = text
    .replace(/\.listen\s*\(([^,\)]+)\s*,\s*['"]127\.0\.0\.1['"]/, '.listen($1, \'0.0.0.0\'')
    .replace(/\.listen\s*\(([^,\)]+)\s*,\s*['"]localhost['"]/, '.listen($1, \'0.0.0.0\'');
  if (next === text) throw new Error('The expected localhost listen pattern was not found.');
  await fs.writeFile(full, next);
}

async function workflowPackagesWrite(sourceDir) {
  const file = path.join(sourceDir, '.github/workflows/docker.yml');
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  if (!text) return null;
  if (/^\s*packages:\s*write\s*$/m.test(text)) return null;
  if (!/(?:docker\/login-action|docker\/build-push-action|ghcr\.io)/i.test(text)) return null;
  return { ruleId: 'GH_ACTIONS_PERMISSION_MISSING', fingerprint: 'GHCR_PACKAGE_WRITE_PERMISSION', layer: 'GHCR_ERROR', risk: 'SAFE', repair: 'workflow-packages', reason: 'The GHCR image workflow is missing packages: write.' };
}

async function ensureWorkflowPackagesWrite(sourceDir) {
  const file = path.join(sourceDir, '.github/workflows/docker.yml');
  let text = await fs.readFile(file, 'utf8');
  if (/^\s*packages:\s*write\s*$/m.test(text)) return file;
  if (/^\s*permissions:\s*$/m.test(text)) {
    text = text.replace(/^(\s*permissions:\s*)$/m, '$1\n  packages: write');
  } else {
    const marker = /^jobs:\s*$/m;
    if (!marker.test(text)) throw new Error('Could not locate workflow jobs block safely.');
    text = text.replace(marker, 'permissions:\n  packages: write\n\njobs:');
  }
  await fs.writeFile(file, text);
  return file;
}

async function fileManifest(sourceDir) {
  const manifest = {};
  for (const rel of await listFiles(sourceDir)) {
    if (rel.startsWith('.git/') || rel.startsWith('node_modules/')) continue;
    const data = await fs.readFile(path.join(sourceDir, rel)).catch(() => null);
    if (data) manifest[rel] = crypto.createHash('sha256').update(data).digest('hex');
  }
  return manifest;
}

function diffManifest(before = {}, after = {}) {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names].filter((name) => before[name] !== after[name]).sort();
}

function manifestHash(manifest = {}) {
  const data = Object.keys(manifest).sort().map((key) => `${key}:${manifest[key]}`).join('|');
  return crypto.createHash('sha256').update(data).digest('hex');
}

function normalizeFile(file) {
  return String(file || '').replace(/\\/g, '/').replace(/\/$/, '');
}

function report(row) {
  const history = [...(row.history || []), {
    fingerprint: row.fingerprint,
    ruleId: row.ruleId,
    result: row.ok ? 'patched' : 'skipped',
    files: row.files || [],
    sourceHash: row.sourceHash || manifestHash(row.before || {}),
  }];
  return {
    ok: Boolean(row.ok),
    stopped: Boolean(row.stopped),
    fingerprint: row.fingerprint || 'UNKNOWN',
    layer: row.layer || classifyLayer(row.fingerprint),
    ruleId: row.ruleId || null,
    files: row.files || [],
    added: row.added || [],
    reason: row.reason || '',
    next: row.next || (row.ok ? 'CONTINUE' : 'AI'),
    aiRequired: row.next === 'AI',
    userAction: row.next === 'USER_ACTION',
    history,
    before: row.before,
    after: row.after,
    changed: row.changed || [],
    unexpected: row.unexpected || [],
    sourceHash: row.sourceHash || manifestHash(row.before || {}),
  };
}

export function formatDareReport(result) {
  if (!result) return '';
  if (result.ok) {
    return [
      '🛠 Auto Repair',
      `Detected: ${result.fingerprint}`,
      `Fix: ${result.reason}`,
      `Files: ${(result.files || []).join(', ') || 'none'}`,
      `Validation target: rebuild + runtime/HTTP verification`,
      'Result: deterministic patch applied; verification must pass before success is reported.',
    ].join('\n');
  }
  if (result.userAction) {
    return [
      '🔐 User action required',
      result.reason || result.fingerprint,
      'Builder will not change account permissions, secrets, wallet data, or security settings automatically.',
    ].join('\n');
  }
  if (result.stopped) {
    return `⚠ Needs attention\n${result.reason}\nAI diagnosis is available only after deterministic repair is exhausted.`;
  }
  return `⚠ DARE could not safely repair this (${result.fingerprint}). ${result.reason}`;
}

export { fingerprintError, classifyLayer, isBuiltinModule };
