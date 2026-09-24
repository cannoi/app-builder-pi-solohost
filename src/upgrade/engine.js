import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { listFiles, readJson } from '../utils/fsx.js';
import { scanProject } from '../security/scanner.js';
import { runStaticTests, runNodeTests } from '../testing/engine.js';
import { runDare } from '../dare/engine.js';
import { findMissingNodeModules } from '../projects/deps-fix.js';
import { writeGeneratedFiles } from '../projects/generator.js';

const MAX_SAFE_REPAIRS = 2;
const PROTECTED = /^(?:\.env(?:\.|$)|.*\/(?:\.env(?:\.|$)|id_rsa(?:\.|$)|private[_-]?key(?:\.|$)))/i;

export async function inspectUpgrade({ project, projects, snapshots, log }) {
  const sourceDir = projects.sourceDir(project.slug);
  const before = await fileManifest(sourceDir);
  const stack = await discoverStack(sourceDir);
  const security = await scanProject(sourceDir);
  const staticResult = await runStaticTests(sourceDir);
  const nodeResult = await runNodeTests(sourceDir, 45000);
  const issues = classifyIssues({ stack, security, staticResult, nodeResult });

  const safeRepairs = [];
  let repairHistory = await projects.readMetadata(project, 'upgrade-repair-history.json', []);
  for (let attempt = 0; attempt < MAX_SAFE_REPAIRS; attempt += 1) {
    if (!(await hasDeterministicCandidate(sourceDir))) break;
    const checkpoint = await snapshots.create(project, `before-upgrade-safe-${attempt + 1}`);
    const repair = await runDare({
      sourceDir,
      logs: 'Upgrade preflight deterministic inspection: module/config/runtime/lockfile/workflow checks.',
      extra: { message: 'preflight module configuration workflow lockfile' },
      history: repairHistory,
    });
    if (!repair?.ok) {
      if (repair?.stopped || repair?.next === 'AI' || repair?.next === 'USER_ACTION') break;
      break;
    }
    const after = await fileManifest(sourceDir);
    const changed = diffManifest(before, after);
    const allowed = new Set((repair.files || []).map(normalize));
    const unexpected = changed.filter((f) => !allowed.has(normalize(f)));
    if (unexpected.length) {
      await snapshots.restore(project, checkpoint.id);
      throw new Error(`Upgrade safety check stopped: unexpected files changed: ${unexpected.join(', ')}`);
    }
    const afterStatic = await runStaticTests(sourceDir);
    const afterNode = await runNodeTests(sourceDir, 45000);
    const afterSecurity = await scanProject(sourceDir);
    if (score(afterStatic, afterNode, afterSecurity) > score(staticResult, nodeResult, security)) {
      await snapshots.restore(project, checkpoint.id);
      break;
    }
    const entry = {
      at: new Date().toISOString(), fingerprint: repair.fingerprint, ruleId: repair.ruleId,
      files: repair.files || [], reason: repair.reason, checkpointId: checkpoint.id,
      beforeHash: manifestHash(before), afterHash: manifestHash(after),
    };
    repairHistory = [...repairHistory, entry].slice(-20);
    safeRepairs.push(entry);
    // Re-run DARE against the new source state. History prevents a repeat patch.
  }

  await projects.saveMetadata(project, 'upgrade-repair-history.json', repairHistory);
  const after = await fileManifest(sourceDir);
  const refreshed = await inspectState(sourceDir);
  const knowledge = buildKnowledgeMap(project, stack, refreshed, after, safeRepairs);
  const baseline = {
    createdAt: new Date().toISOString(),
    sourceHash: manifestHash(after),
    fileCount: after.length,
    stack,
    health: refreshed.health,
    security: summarizeSecurity(refreshed.security),
    knownIssues: refreshed.issues,
    safeRepairs,
    evidence: { static: refreshed.staticResult.status, node: refreshed.nodeResult.status },
  };
  await projects.saveMetadata(project, 'upgrade-knowledge.json', knowledge);
  await projects.saveMetadata(project, 'upgrade-baseline.json', baseline);
  await appendUpgradeHistory(projects, project, {
    kind: 'inspect', at: baseline.createdAt, result: 'baseline-created', safeRepairs,
  });
  log?.info?.('Upgrade baseline created', { project: project.slug, files: after.length, safeRepairs: safeRepairs.length });
  return { baseline, knowledge, issues: refreshed.issues, safeRepairs, ready: true };
}

export async function diagnoseUpgradeRequest({ project, projects, ai, request }) {
  const sourceDir = projects.sourceDir(project.slug);
  const knowledge = await projects.readMetadata(project, 'upgrade-knowledge.json', {});
  const baseline = await projects.readMetadata(project, 'upgrade-baseline.json', {});
  const relevant = await relevantContext(sourceDir, request);
  const prompt = `UPGRADE WORKSHOP — EXISTING APP ONLY\n\nPreserve the existing application. Do not redesign or regenerate it.\n\nAPP KNOWLEDGE MAP:\n${JSON.stringify(knowledge)}\n\nBASELINE:\n${JSON.stringify(baseline)}\n\nUSER REQUEST:\n${String(request).trim()}\n\nRELEVANT SOURCE EVIDENCE:\n${relevant}\n\nReturn JSON only with:\n{\n  "root_cause": "evidence-based diagnosis",\n  "recommendation": "smallest effective upgrade",\n  "risk": "low|medium|high",\n  "files": [{"path":"relative/file","content":"complete replacement content"}],\n  "expected_result": "verifiable result",\n  "verification": ["checks"],\n  "alternatives": [{"name":"...","risk":"...","scope":"..."}]\n}\nRules: do not invent facts; do not propose dependency-wide upgrades; do not modify secrets, credentials, database schema, auth, payment, wallet, or Docker architecture unless explicitly required and marked high risk.`;
  const result = await ai.completeJson({ task: 'UPGRADE_WORKSHOP', system: 'You are the Upgrade Workshop. Inspect first, diagnose from evidence, recommend the smallest effective change, and preserve the existing app.', prompt, projectId: project.id });
  return result.json || {};
}

export async function applyUpgrade({ project, projects, snapshots, plan, request, approved = false }) {
  const risk = String(plan?.risk || 'high').toLowerCase();
  if (risk === 'high' && !approved) throw new Error('NEEDS_USER_ACTION: High-risk upgrade needs an explicit review. Cancel unless you accept the risk.');
  if (risk !== 'low' && risk !== 'medium' && !approved) throw new Error('NEEDS_USER_ACTION: Upgrade plan is not low risk. Review and approve the change before applying it.');
  if (risk === 'medium' && !approved) throw new Error('NEEDS_USER_ACTION: Medium-risk upgrade needs your Apply confirmation.');
  const files = Array.isArray(plan.files) ? plan.files.filter((f) => f && f.path && typeof f.content === 'string') : [];
  if (!files.length) throw new Error('Upgrade plan contains no file changes.');
  if (files.length > 8) throw new Error('Upgrade scope is too large for an automatic minimal patch.');
  const sourceDir = projects.sourceDir(project.slug);
  const before = await fileManifest(sourceDir);
  const checkpoint = await snapshots.create(project, 'before-upgrade');
  for (const f of files) {
    const rel = normalize(f.path);
    if (!rel || rel.startsWith('/') || rel.includes('..') || PROTECTED.test(rel)) throw new Error(`Upgrade attempted to modify a protected or unsafe file: ${rel}`);
    if (Buffer.byteLength(f.content, 'utf8') > 1024 * 1024) throw new Error(`Upgrade file is too large: ${rel}`);
  }
  const written = await writeGeneratedFiles(sourceDir, files);
  const after = await fileManifest(sourceDir);
  const changed = diffManifest(before, after);
  const unexpected = changed.filter((f) => !written.map(normalize).includes(normalize(f)));
  if (unexpected.length) {
    await snapshots.restore(project, checkpoint.id);
    throw new Error(`Upgrade rolled back: unexpected files changed: ${unexpected.join(', ')}`);
  }
  const verified = await inspectState(sourceDir);
  const baseline = await projects.readMetadata(project, 'upgrade-baseline.json', {});
  const baselineScore = Number(baseline?.health?.score ?? 0);
  const currentScore = score(verified.staticResult, verified.nodeResult, verified.security);
  if (verified.security.critical > 0 || currentScore > Math.max(0, baselineScore)) {
    await snapshots.restore(project, checkpoint.id);
    throw new Error('Upgrade rolled back because verification regressed the app.');
  }
  await appendUpgradeHistory(projects, project, {
    kind: 'upgrade', at: new Date().toISOString(), request, rootCause: plan.root_cause,
    files: written, verification: verified.health, checkpointId: checkpoint.id, result: 'verified',
  });
  await projects.saveMetadata(project, 'upgrade-baseline.json', { ...baseline, updatedAt: new Date().toISOString(), sourceHash: manifestHash(after), knownIssues: verified.issues });
  return { ok: true, files: written, verification: verified.health, checkpointId: checkpoint.id };
}

async function inspectState(sourceDir) {
  const [security, staticResult, nodeResult, manifest] = await Promise.all([
    scanProject(sourceDir), runStaticTests(sourceDir), runNodeTests(sourceDir, 45000), fileManifest(sourceDir),
  ]);
  const issues = classifyIssues({ stack: await discoverStack(sourceDir), security, staticResult, nodeResult });
  return {
    security, staticResult, nodeResult, issues,
    health: {
      status: security.critical ? 'NEEDS_ATTENTION' : webAppHealth(staticResult, nodeResult, security),
      score: score(staticResult, nodeResult, security),
      fileCount: manifest.length,
    },
  };
}

async function hasDeterministicCandidate(sourceDir) {
  const deps = await findMissingNodeModules(sourceDir).catch(() => ({ missing: [] }));
  if (deps.missing?.length) return true;
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(sourceDir, 'package.json'), 'utf8'));
    if (!pkg.scripts?.start) {
      const results = await Promise.all(['server.js', 'index.js', 'app.js'].map((name) => fs.access(path.join(sourceDir, name)).then(() => true).catch(() => false)));
      if (results.filter(Boolean).length === 1) return true;
    }
  } catch {}
  const files = await listFiles(sourceDir);
  for (const rel of files.filter((f) => /\.(js|mjs|cjs|ts|tsx)$/.test(f))) {
    const text = await fs.readFile(path.join(sourceDir, rel), 'utf8').catch(() => '');
    if (/\.listen\s*\([^)]*['"](?:127\.0\.0\.1|localhost)['"]/i.test(text)) return true;
  }
  const workflow = await fs.readFile(path.join(sourceDir, '.github/workflows/docker.yml'), 'utf8').catch(() => '');
  if (workflow && /(?:docker\/login-action|docker\/build-push-action|ghcr\.io)/i.test(workflow) && !/^\s*packages:\s*write\s*$/m.test(workflow)) return true;
  return false;
}

async function discoverStack(sourceDir) {
  const files = await listFiles(sourceDir);
  const names = new Set(files.map((f) => path.basename(f)));
  let pkg = {};
  try { pkg = JSON.parse(await fs.readFile(path.join(sourceDir, 'package.json'), 'utf8')); } catch {}
  return {
    language: names.has('package.json') ? 'javascript' : names.has('requirements.txt') || names.has('pyproject.toml') ? 'python' : 'unknown',
    packageManager: names.has('pnpm-lock.yaml') ? 'pnpm' : names.has('yarn.lock') ? 'yarn' : names.has('bun.lock') || names.has('bun.lockb') ? 'bun' : names.has('package-lock.json') ? 'npm' : null,
    docker: names.has('Dockerfile') || names.has('docker-compose.yml') || names.has('compose.yml'),
    framework: detectFramework(files, pkg),
    entryPoints: files.filter((f) => /(^|\/)(server|index|app)\.(js|mjs|cjs|ts|tsx)$/.test(f)).slice(0, 10),
    routes: files.filter((f) => /(^|\/)(routes?|pages?|api)(\/|\.)/i.test(f)).slice(0, 50),
    dependencies: Object.keys(pkg.dependencies || {}),
  };
}

function detectFramework(files, pkg) {
  const d = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  if (d.next) return 'Next.js'; if (d.vite) return 'Vite'; if (d.react) return 'React'; if (d.vue) return 'Vue'; if (d.express) return 'Express';
  if (files.some((f) => /\.html$/.test(f))) return 'Static Web';
  return 'Unknown';
}

function classifyIssues({ stack, security, staticResult, nodeResult }) {
  const out = [];
  for (const f of security.findings || []) out.push({ id: f.id, category: 'SECURITY', severity: f.severity, evidence: `${f.file}${f.line ? `:${f.line}` : ''}`, autoFix: Boolean(f.autoFix) });
  if (staticResult.status === 'failed') out.push({ id: 'static-tests', category: 'BUG', severity: 'high', evidence: staticResult.summary || 'Static checks failed', autoFix: false });
  if (nodeResult.status === 'failed') out.push({ id: 'node-tests', category: 'RUNTIME', severity: 'high', evidence: nodeResult.summary || 'Node tests failed', autoFix: false });
  if (!out.length) out.push({ id: 'healthy', category: 'INFO', severity: 'info', evidence: 'No blocking issue found in deterministic inspection.', autoFix: false });
  return out;
}

function buildKnowledgeMap(project, stack, state, manifest, repairs) {
  return {
    project: { id: project.id, slug: project.slug, name: project.name },
    stack, architecture: { entryPoints: stack.entryPoints, routes: stack.routes, docker: stack.docker },
    dependencies: stack.dependencies, features: discoverFeatures(manifest, stack),
    runtime: state.health, security: summarizeSecurity(state.security), knownIssues: state.issues,
    baselineVersion: project.version, safeRepairs: repairs, evidence: { files: manifest.length, sourceHash: manifestHash(manifest) },
    generatedAt: new Date().toISOString(),
  };
}

async function relevantContext(sourceDir, request) {
  const files = await listFiles(sourceDir);
  const keywords = String(request).toLowerCase().split(/[^a-z0-9_-]+/i).filter((x) => x.length > 3).slice(0, 12);
  const selected = files.filter((f) => /package\.json|Dockerfile|compose|config|route|api|server|app|index|readme/i.test(f) || keywords.some((k) => f.toLowerCase().includes(k))).slice(0, 40);
  const parts = [];
  for (const rel of selected) {
    const text = await fs.readFile(path.join(sourceDir, rel), 'utf8').catch(() => '');
    if (text) parts.push(`FILE ${rel}\n${text.slice(0, 12000)}`);
  }
  return parts.join('\n\n').slice(0, 100000);
}

async function fileManifest(sourceDir) {
  const files = await listFiles(sourceDir);
  const out = [];
  for (const rel of files) {
    const full = path.join(sourceDir, rel);
    const stat = await fs.stat(full).catch(() => null); if (!stat?.isFile()) continue;
    const hash = crypto.createHash('sha256');
    const data = await fs.readFile(full);
    hash.update(data);
    out.push({ path: normalize(rel), size: stat.size, sha256: hash.digest('hex') });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function diffManifest(before, after) {
  const a = new Map((before || []).map((x) => [normalize(x.path), x.sha256]));
  const b = new Map((after || []).map((x) => [normalize(x.path), x.sha256]));
  const changed = [];
  for (const [p, h] of b) if (a.get(p) !== h) changed.push(p);
  for (const p of a.keys()) if (!b.has(p)) changed.push(p);
  return changed;
}

function manifestHash(manifest) { return crypto.createHash('sha256').update(JSON.stringify(manifest || [])).digest('hex'); }
function normalize(p) { return String(p || '').replace(/\\/g, '/').replace(/^\.\//, ''); }
function score(staticResult, nodeResult, security) { return (staticResult?.status === 'failed' ? 2 : 0) + (nodeResult?.status === 'failed' ? 2 : 0) + Number(security?.critical || 0) * 4 + Number(security?.warning || 0); }
function summarizeSecurity(s) { return { status: s.status, critical: s.critical, warning: s.warning, findings: (s.findings || []).map((f) => ({ id: f.id, severity: f.severity, file: f.file, title: f.title })) }; }

function webAppHealth(staticResult, nodeResult, security) {
  if (security?.critical) return 'NEEDS_ATTENTION';
  if (nodeResult?.status === 'failed' && nodeResult?.reason !== 'No package.json') return 'NEEDS_ATTENTION';
  if (staticResult?.status === 'failed') {
    const failed = (staticResult.checks || []).filter((c) => !c.ok).map((c) => c.name);
    const onlyScaffold = failed.every((n) => /package\.json|README|Dockerfile|\.env\.example/.test(n));
    if (!onlyScaffold) return 'NEEDS_ATTENTION';
  }
  return 'HEALTHY';
}

function discoverFeatures(manifest, stack) {
  const names = (manifest || []).map((f) => String(f.path || f).toLowerCase());
  const feats = [];
  if (names.some((n) => /login|auth|session/.test(n))) feats.push('Authentication');
  if (names.some((n) => /upload/.test(n))) feats.push('Upload');
  if (names.some((n) => /search/.test(n))) feats.push('Search');
  if (names.some((n) => /admin/.test(n))) feats.push('Admin');
  if (names.some((n) => /chat/.test(n))) feats.push('Chat');
  if (names.some((n) => /setting/.test(n))) feats.push('Settings');
  if (stack?.routes?.length) feats.push('API/Routes');
  if (names.some((n) => /\.html$/.test(n))) feats.push('Web UI');
  return feats.slice(0, 12);
}

async function appendUpgradeHistory(projects, project, entry) {
  const raw = await projects.readMetadata(project, 'upgrade-history.json', []);
  const rows = Array.isArray(raw) ? raw : raw ? [raw] : [];
  rows.push(entry);
  await projects.saveMetadata(project, 'upgrade-history.json', rows.slice(-40));
}
