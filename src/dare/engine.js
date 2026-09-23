import fs from 'node:fs/promises';
import path from 'node:path';
import { fingerprintError, classifyLayer, isBuiltinModule } from './fingerprint.js';
import { ensureMissingDependencies, findMissingNodeModules } from '../projects/deps-fix.js';
import { listFiles } from '../utils/fsx.js';

const MAX_ATTEMPTS_PER_PRINT = 1;
const MAX_CYCLES = 2;

export async function runDare({ sourceDir, logs = '', extra = {}, history = [] } = {}) {
  const fp = fingerprintError(`${logs}\n${extra.message || ''}`);
  const layer = classifyLayer(fp);
  const attempted = history.filter((h) => h.fingerprint === fp);
  if (attempted.length >= MAX_ATTEMPTS_PER_PRINT || history.length >= MAX_CYCLES) {
    return report({
      ok: false, stopped: true, fingerprint: fp, layer,
      reason: 'Loop protection stopped another automatic repair of the same error.',
      next: fp === 'APP_LOGIC_UNKNOWN' ? 'AI' : 'USER_ACTION',
    });
  }

  if (fp === 'APP_LOGIC_UNKNOWN' || fp === 'UNKNOWN' || fp === 'NONE') {
    const preflight = await preflightScan(sourceDir);
    if (preflight.repair) return applyAction(sourceDir, preflight, history);
    return report({
      ok: false, fingerprint: fp, layer,
      reason: fp === 'NONE' ? 'No error text to fingerprint.' : 'No safe deterministic rule.',
      next: 'AI',
      preflight,
    });
  }

  const action = await matchRule(sourceDir, fp, logs);
  if (!action) {
    return report({
      ok: false, fingerprint: fp, layer,
      reason: 'DARE has no safe rule for this fingerprint.',
      next: layer === 'GHCR_ERROR' ? 'USER_ACTION' : 'AI',
    });
  }
  if (action.risk === 'UNSAFE') {
    return report({ ok: false, fingerprint: fp, layer, reason: action.reason, next: action.next || 'USER_ACTION' });
  }
  return applyAction(sourceDir, { ...action, fingerprint: fp, layer }, history);
}

async function preflightScan(sourceDir) {
  const missing = await findMissingNodeModules(sourceDir).catch(() => ({ missing: [] }));
  if (missing.missing?.length) {
    return {
      ruleId: 'NODE_MODULE_MISSING',
      fingerprint: `NODE_MODULE_MISSING:${missing.missing[0]}`,
      layer: 'DEPENDENCY_ERROR',
      risk: 'SAFE',
      reason: `Missing dependency: ${missing.missing.join(', ')}`,
      repair: 'deps',
    };
  }
  const start = await missingStartScript(sourceDir);
  if (start) return start;
  const bind = await localhostBind(sourceDir);
  if (bind) return bind;
  const wf = await workflowPackagesWrite(sourceDir);
  if (wf) return wf;
  return { action: false };
}

async function matchRule(sourceDir, fp, logs) {
  if (fp.startsWith('NODE_MODULE_MISSING:')) {
    return { ruleId: 'NODE_MODULE_MISSING', risk: 'SAFE', repair: 'deps', reason: `Missing dependency: ${fp.split(':')[1]}` };
  }
  if (fp === 'NPM_SCRIPT_MISSING:start') return missingStartScript(sourceDir);
  if (fp === 'DOCKER_LOCALHOST_BIND') return localhostBind(sourceDir);
  if (fp === 'SQLITE_DIRECTORY_MISSING') {
    return { ruleId: 'SQLITE_DIRECTORY_MISSING', risk: 'SAFE', repair: 'sqlite-dir', reason: 'SQLite data directory is missing.' };
  }
  if (fp === 'GHCR_PACKAGE_WRITE_PERMISSION') {
    const wf = await workflowPackagesWrite(sourceDir);
    return wf || { ruleId: 'GHCR_PACKAGE_WRITE_PERMISSION', risk: 'UNSAFE', reason: 'GitHub account/repo does not allow package publish.', next: 'USER_ACTION' };
  }
  if (fp === 'DOCKER_CONTAINER_CRASH' && /cannot find module/i.test(logs)) {
    return { ruleId: 'NODE_MODULE_MISSING', risk: 'SAFE', repair: 'deps', reason: 'Container crashed because a Node package is missing.' };
  }
  if (fp === 'NPM_LOCKFILE_OUT_OF_SYNC') {
    return { ruleId: 'NPM_LOCKFILE_OUT_OF_SYNC', risk: 'MEDIUM', repair: 'noop-lock', reason: 'Lockfile is out of date; install will refresh it on next build.' };
  }
  return null;
}

async function applyAction(sourceDir, action, history) {
  const files = [];
  if (action.repair === 'deps') {
    const result = await ensureMissingDependencies(sourceDir);
    if (!result.changed) {
      return report({ ok: false, fingerprint: action.fingerprint, layer: action.layer || 'DEPENDENCY_ERROR', reason: 'Dependencies already match source imports.', next: 'AI', history });
    }
    files.push('package.json');
    if (result.dockerfile) files.push('Dockerfile');
    return report({
      ok: true, fingerprint: action.fingerprint || `NODE_MODULE_MISSING:${(result.added || []).join(',')}`,
      layer: 'DEPENDENCY_ERROR', ruleId: 'NODE_MODULE_MISSING', files, added: result.added,
      reason: `Added ${result.added.join(', ')} to package.json.`, next: 'CONTINUE', history,
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
  if (action.repair === 'sqlite-dir') {
    await fs.mkdir(path.join(sourceDir, 'data'), { recursive: true });
    await fs.mkdir(path.join(sourceDir, 'uploads'), { recursive: true });
    return report({ ok: true, fingerprint: 'SQLITE_DIRECTORY_MISSING', layer: 'RUNTIME_ERROR', ruleId: 'SQLITE_DIRECTORY_MISSING', files: ['data/', 'uploads/'], reason: 'Created writable data directories for SQLite/uploads.', next: 'CONTINUE', history });
  }
  if (action.repair === 'workflow-packages') {
    await ensureWorkflowPackagesWrite(sourceDir);
    return report({ ok: true, fingerprint: 'GHCR_PACKAGE_WRITE_PERMISSION', layer: 'GHCR_ERROR', ruleId: 'GH_ACTIONS_PERMISSION_MISSING', files: ['.github/workflows/docker.yml'], reason: 'Added packages: write to the image workflow.', next: 'CONTINUE', history });
  }
  if (action.repair === 'noop-lock') {
    return report({ ok: true, fingerprint: 'NPM_LOCKFILE_OUT_OF_SYNC', layer: 'DEPENDENCY_ERROR', ruleId: 'NPM_LOCKFILE_OUT_OF_SYNC', files: [], reason: 'Next image build will refresh the lockfile via npm install.', next: 'CONTINUE', history });
  }
  return report({ ok: false, fingerprint: action.fingerprint || 'UNKNOWN', layer: action.layer || 'UNKNOWN', reason: 'Rule matched but produced no patch.', next: 'AI', history });
}

async function missingStartScript(sourceDir) {
  const pkgPath = path.join(sourceDir, 'package.json');
  const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8').catch(() => 'null'));
  if (!pkg) return null;
  if (pkg.scripts?.start) return null;
  const candidates = ['server.js', 'index.js', 'app.js'].filter(Boolean);
  const present = [];
  for (const name of candidates) {
    try { await fs.access(path.join(sourceDir, name)); present.push(name); } catch {}
  }
  if (present.length !== 1) return null;
  return { ruleId: 'NPM_SCRIPT_MISSING', fingerprint: 'NPM_SCRIPT_MISSING:start', layer: 'DEPENDENCY_ERROR', risk: 'SAFE', repair: 'start-script', start: `node ${present[0]}`, reason: `Missing start script; unique entry is ${present[0]}.` };
}

async function localhostBind(sourceDir) {
  const files = await listFiles(sourceDir);
  for (const rel of files) {
    if (!/\.(js|mjs|cjs)$/.test(rel) || rel.startsWith('node_modules/')) continue;
    const text = await fs.readFile(path.join(sourceDir, rel), 'utf8').catch(() => '');
    if (/\.listen\s*\([^)]*(['"]127\.0\.0\.1['"]|['"]localhost['"])/.test(text)) {
      return { ruleId: 'DOCKER_LOCALHOST_BIND', fingerprint: 'DOCKER_LOCALHOST_BIND', layer: 'CONTAINER_ERROR', risk: 'MEDIUM', repair: 'bind-all', file: rel, reason: `${rel} binds the HTTP server to localhost.` };
    }
  }
  return null;
}

async function workflowPackagesWrite(sourceDir) {
  const file = path.join(sourceDir, '.github/workflows/docker.yml');
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  if (!text) return null;
  if (/packages:\s*write/.test(text)) return null;
  return { ruleId: 'GH_ACTIONS_PERMISSION_MISSING', fingerprint: 'GHCR_PACKAGE_WRITE_PERMISSION', layer: 'GHCR_ERROR', risk: 'SAFE', repair: 'workflow-packages', reason: 'Image workflow is missing packages: write.' };
}

async function patchPackageStart(sourceDir, start) {
  const pkgPath = path.join(sourceDir, 'package.json');
  const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
  pkg.scripts = { ...(pkg.scripts || {}), start };
  await fs.writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

async function patchListenBind(full) {
  let text = await fs.readFile(full, 'utf8');
  text = text.replace(/\.listen\s*\(([^,\)]+)\s*,\s*['"]127\.0\.0\.1['"]/, '.listen($1, \'0.0.0.0\'');
  text = text.replace(/\.listen\s*\(([^,\)]+)\s*,\s*['"]localhost['"]/, '.listen($1, \'0.0.0.0\'');
  await fs.writeFile(full, text);
}

async function ensureWorkflowPackagesWrite(sourceDir) {
  const file = path.join(sourceDir, '.github/workflows/docker.yml');
  let text = await fs.readFile(file, 'utf8');
  if (/permissions:\s*\n(?:[ \t]+[^\n]+\n)*[ \t]+packages:\s*write/.test(text)) return;
  if (/permissions:/.test(text)) {
    text = text.replace(/permissions:\s*\n/, 'permissions:\n  packages: write\n');
  } else {
    text = text.replace(/jobs:/, 'permissions:\n  contents: read\n  packages: write\n\njobs:');
  }
  await fs.writeFile(file, text);
}

function report(row) {
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
    history: [...(row.history || []), { fingerprint: row.fingerprint, ruleId: row.ruleId, result: row.ok ? 'patched' : 'skipped' }],
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
      'Result: patched. Re-run Build / Publish to verify.',
    ].join('\n');
  }
  if (result.userAction) {
    return [
      '🔐 User action required',
      result.reason || result.fingerprint,
      'This is a GitHub/account permission or secret — Builder will not change it.',
    ].join('\n');
  }
  if (result.stopped) {
    return `⚠ Needs attention\n${result.reason}\nAI diagnosis is available if a provider key still has quota.`;
  }
  return `⚠ DARE could not safely repair this (${result.fingerprint}). ${result.reason}`;
}

export { fingerprintError, classifyLayer, isBuiltinModule };
