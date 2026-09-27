import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { listFiles, readJson } from '../utils/fsx.js';
import { scanProject } from '../security/scanner.js';
import { runStaticTests, runNodeTests } from '../testing/engine.js';
import { runDare } from '../dare/engine.js';
import { findMissingNodeModules } from '../projects/deps-fix.js';
import { writeGeneratedFiles } from '../projects/generator.js';
import { parseRule, capabilityGap, formatRuleStatus, buildRuleTasks, normalizeExecution } from './rules.js';

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
    // Upgrade inspection must include the SoloHost runtime contract even when
    // source-level tests are green. A non-root Docker image can pass Node tests
    // and still crash at startup on SoloHost (for example EACCES /app/data).
    const candidate = await hasDeterministicCandidate(sourceDir);
    if (!candidate && attempt > 0) break;
    const checkpoint = await snapshots.create(project, `before-upgrade-safe-${attempt + 1}`);
    const repair = await runDare({
      sourceDir,
      logs: 'Upgrade preflight deterministic inspection.',
      extra: { message: 'SOLOHOST_UPGRADE_PREFLIGHT' },
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

export async function diagnoseUpgradeRequest({ project, projects, ai, request, ruleText = '' }) {
  const sourceDir = projects.sourceDir(project.slug);
  const knowledge = await projects.readMetadata(project, 'upgrade-knowledge.json', {});
  const baseline = await projects.readMetadata(project, 'upgrade-baseline.json', {});
  const parsed = parseRule(ruleText || (/RULE_NAME|REQUIRED CAPABILITIES|REQUIRED_CAPABILITIES/i.test(request || '') ? request : ''));
  const relevant = await relevantContext(sourceDir, `${request}\n${parsed.valid ? parsed.requiredCapabilities.join(' ') : ''}`);
  const gap = parsed.valid ? capabilityGap(parsed, relevant) : null;
  if (ruleText && !parsed.valid) throw new Error(parsed.error);
  if (parsed.valid) await projects.saveMetadata(project, 'upgrade-rule.json', { rule: parsed, gap, loadedAt: new Date().toISOString() });
  const prompt = `UPGRADE WORKSHOP — EXISTING APP ONLY

Preserve the existing application. Do not redesign or regenerate it.

APP KNOWLEDGE MAP:
${JSON.stringify(knowledge)}

BASELINE:
${JSON.stringify(baseline)}

RULE:
${parsed.valid ? JSON.stringify({ name: parsed.name, goal: parsed.goal, required: parsed.requiredCapabilities, missing: gap?.missingCapabilities || [], secrets: parsed.secrets }) : 'No structured rule. Treat the user text as a normal upgrade request.'}

USER REQUEST:
${String(request).trim()}

RELEVANT SOURCE EVIDENCE:
${relevant}

Return JSON only with:
{
  "root_cause": "evidence-based diagnosis",
  "recommendation": "smallest effective upgrade",
  "risk": "low|medium|high",
  "files": [{"path":"relative/file","content":"complete replacement content"}],
  "expected_result": "verifiable result",
  "verification": ["checks"],
  "missing_capabilities": [],
  "needs_user_action": "",
  "alternatives": [{"name":"...","risk":"...","scope":"..."}]
}
Rules: do not invent facts; do not propose dependency-wide upgrades; do not modify secrets, credentials, database schema, auth, payment, wallet, or Docker architecture unless explicitly required and marked high risk. If the rule lists required secrets, set needs_user_action instead of writing secrets into source.`;
  const result = await ai.completeJson({ task: 'UPGRADE_WORKSHOP', system: 'You are the Upgrade Workshop. Inspect first, diagnose from evidence, recommend the smallest effective change, and preserve the existing app.', prompt, projectId: project.id });
  return { ...(result.json || {}), rule: parsed.valid ? parsed : null, gap, ruleStatus: parsed.valid ? formatRuleStatus(parsed, gap) : '' };
}

export async function applyUpgrade({ project, projects, snapshots, plan, request, approved = false, ruleExecution = false }) {
  const risk = String(plan?.risk || 'high').toLowerCase();
  // Rule execution may auto-apply proven low/medium-risk patches. High-risk work
  // always stops for a real user decision. Normal chat upgrades keep the existing
  // approval gate.
  if (risk === 'high' && !approved) throw new Error('NEEDS_USER_ACTION: High-risk upgrade needs an explicit review.');
  if (!ruleExecution && risk !== 'low' && risk !== 'medium' && !approved) throw new Error('NEEDS_USER_ACTION: Upgrade plan is not low risk. Review and approve the change before applying it.');
  if (!ruleExecution && risk === 'medium' && !approved) throw new Error('NEEDS_USER_ACTION: Medium-risk upgrade needs your Apply confirmation.');
  if (ruleExecution && risk === 'medium' && plan?.needs_user_action) throw new Error(`NEEDS_USER_ACTION: ${plan.needs_user_action}`);
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

export async function runRuleUpgrade({ project, projects, snapshots, ai, request = '', ruleText = '', emit = () => {} }) {
  const parsed = parseRule(ruleText || request);
  if (!parsed.valid) throw new Error(parsed.error);

  // Defensive normalization is intentional: old/custom Rules can contain
  // EXECUTION: null, missing maxCycles, strings, or extra parameters.
  const execution = normalizeExecution(parsed.execution);
  const sourceDir = projects.sourceDir(project.slug);
  const history = await projects.readMetadata(project, 'upgrade-rule-execution.json', {});
  const previous = Array.isArray(history?.history) ? history.history : [];
  const initialContext = await relevantContext(sourceDir, parsed.requiredCapabilities.join(' '));
  let gap = capabilityGap(parsed, initialContext);
  let tasks = buildRuleTasks(parsed, gap).slice(0, execution.maxTasks);
  const state = {
    rule: parsed.name,
    version: parsed.version,
    execution,
    status: 'running',
    cycle: 0,
    tasks,
    history: previous.slice(-80),
    startedAt: new Date().toISOString(),
  };
  await projects.saveMetadata(project, 'upgrade-rule-execution.json', state);
  emit('rule', 'running', `🧭 Rule loaded: ${parsed.name}. Builder will plan and execute ${tasks.filter(t => t.status === 'pending').length} task(s).`);

  const seen = new Set(previous.map((x) => `${x.capability}|${x.sourceHash}|${x.patchHash || ''}`));
  let userAction = '';
  let completed = 0;
  for (let cycle = 1; cycle <= execution.maxCycles; cycle += 1) {
    state.cycle = cycle;
    const context = await relevantContext(sourceDir, parsed.requiredCapabilities.join(' '));
    gap = capabilityGap(parsed, context);
    if (gap.complete && !tasks.some(t => t.status === 'pending' && t.acceptance)) break;
    const pending = tasks.filter(t => t.status === 'pending').slice(0, execution.maxTasks);
    if (!pending.length) break;
    const task = pending[0];
    const taskRequest = `${request || parsed.goal}\nRULE TASK: Complete only this task: ${task.capability}\nDo not redesign unrelated parts. Inspect current evidence and preserve working behavior.`;
    emit('plan', 'running', `🧩 Task ${completed + 1}/${tasks.length}: ${task.capability}`);
    let plan;
    try {
      // Definition-of-done items are evaluation tasks, not invitations to invent
      // more code. Ask the model to verify evidence first; only a failed criterion
      // becomes a repair task on the next cycle.
      if (task.acceptance) {
        const evaluation = await ai.completeJson({
          task: 'RULE_ACCEPTANCE_CHECK',
          system: 'Evaluate the existing app against one acceptance criterion. Do not modify files. Use only evidence from the supplied project context.',
          prompt: `${taskRequest}\n\nPROJECT EVIDENCE:\n${context}\n\nReturn JSON only: {"passed":true|false,"evidence":"...","missing":"...","next_action":"..."}` ,
          projectId: project.id,
        });
        if (evaluation.json?.passed === true) {
          task.status = 'done'; task.evidence = evaluation.json.evidence || 'Acceptance criterion verified.';
          completed += 1;
          await projects.saveMetadata(project, 'upgrade-rule-execution.json', state);
          emit('verify', 'done', `✓ Verified: ${task.capability}`);
          continue;
        }
        task.status = 'pending';
        task.lastEvaluation = evaluation.json || {};
        task.capability = `${task.capability} — ${evaluation.json?.missing || evaluation.json?.next_action || 'needs implementation'}`;
      }
      plan = await diagnoseUpgradeRequest({ project, projects, ai, request: taskRequest, ruleText: JSON.stringify({ ...parsed, execution }) });
    } catch (err) {
      task.status = 'blocked'; task.error = String(err.message || err).slice(0, 500);
      await projects.saveMetadata(project, 'upgrade-rule-execution.json', state);
      throw err;
    }
    if (plan.needs_user_action) {
      task.status = 'waiting_user'; task.needsUserAction = plan.needs_user_action;
      userAction = plan.needs_user_action;
      emit('input', 'done', `⏸ ${userAction}`);
      if (execution.stopOnUserAction) break;
      continue;
    }
    const risk = String(plan.risk || 'high').toLowerCase();
    if (risk === 'high') {
      task.status = 'waiting_user'; task.needsUserAction = 'This step is high risk and needs your confirmation.';
      userAction = task.needsUserAction;
      emit('input', 'done', `⏸ ${userAction}`);
      break;
    }
    const before = await fileManifest(sourceDir);
    const sourceHash = manifestHash(before);
    const patchHash = crypto.createHash('sha256').update(JSON.stringify(plan.files || [])).digest('hex');
    const key = `${task.capability}|${sourceHash}|${patchHash}`;
    if (seen.has(key)) {
      task.status = 'blocked'; task.error = 'Same repair already attempted for the same source state.';
      emit('guard', 'done', `🛑 Same repair blocked: ${task.capability}`);
      break;
    }
    seen.add(key);
    try {
      const result = await applyUpgrade({ project, projects, snapshots, plan, request: taskRequest, approved: true, ruleExecution: true });
      task.status = 'done'; task.files = result.files; task.verification = result.verification;
      completed += 1;
      state.history.push({ cycle, capability: task.capability, sourceHash, patchHash, files: result.files, result: 'verified', at: new Date().toISOString() });
      emit('verify', 'done', `✓ Verified: ${task.capability}`);
    } catch (err) {
      task.status = 'failed'; task.error = String(err.message || err).slice(0, 700);
      state.history.push({ cycle, capability: task.capability, sourceHash, patchHash, result: 'failed', error: task.error, at: new Date().toISOString() });
      emit('verify', 'failed', `⚠ ${task.capability}: ${task.error}`);
      task.retries = Number(task.retries || 0) + 1;
      if (task.retries > execution.maxRetriesPerTask) break;
      // Re-plan once from fresh evidence. The same source+patch fingerprint is
      // blocked above, so a retry can only happen with genuinely different evidence.
      task.status = 'pending';
      continue;
    }
    await projects.saveMetadata(project, 'upgrade-rule-execution.json', state);
    // Rebuild task status from fresh evidence after every successful patch.
    const afterContext = await relevantContext(sourceDir, parsed.requiredCapabilities.join(' '));
    gap = capabilityGap(parsed, afterContext);
    for (const t of tasks) {
      if (gap.currentCapabilities.some(c => String(c).toLowerCase() === String(t.capability).toLowerCase())) t.status = 'satisfied';
    }
  }
  const finalContext = await relevantContext(sourceDir, parsed.requiredCapabilities.join(' '));
  gap = capabilityGap(parsed, finalContext);
  const pending = tasks.filter(t => t.status === 'pending');
  const blocked = tasks.filter(t => ['blocked','failed'].includes(t.status));
  state.status = userAction ? 'NEEDS_USER_ACTION' : (!pending.length && !blocked.length ? 'completed' : 'stopped');
  state.finishedAt = new Date().toISOString();
  state.gap = gap;
  state.tasks = tasks;
  await projects.saveMetadata(project, 'upgrade-rule-execution.json', state);
  return {
    projectId: project.id,
    rule: parsed,
    execution: state,
    status: state.status,
    completedTasks: tasks.filter(t => t.status === 'done' || t.status === 'satisfied').length,
    totalTasks: tasks.length,
    needsUserAction: userAction,
    gap,
    brief: userAction
      ? `⏸ Rule paused: ${userAction}`
      : state.status === 'completed'
        ? `✓ Rule completed: ${parsed.name}`
        : `⚠ Rule stopped safely after ${completed} verified task(s). No failed repair was repeated.`,
  };
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
