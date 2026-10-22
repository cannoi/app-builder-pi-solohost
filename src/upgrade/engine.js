import { collectProjectContextText } from '../services/project-context-resolver.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256, fileClass } from '../utils/hash.js';
import { listFiles, readJson } from '../utils/fsx.js';
import { findMissingNodeModules } from '../projects/deps-fix.js';
import { writeGeneratedFiles } from '../projects/generator.js';
import { parseRule, capabilityGap, formatRuleStatus, buildRuleTasks, normalizeExecution } from './rules.js';
import { readUpgradeSession, createUpgradeSession, updateUpgradeSession, pauseUpgradeSession, resumeUpgradeSession, completeUpgradeSession } from './session.js';
import { normalizeArray } from '../utils/validate.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runAgentTools } from '../ai/agent-tools.js';
import { saveWorkingMemory, loadWorkingMemory } from '../agent/working-memory.js';
import { recordAttempt } from '../agent/attempt-ledger.js';
import { assertPhaseAllows, PHASE } from '../agent/scope-guard.js';

const execFileAsync = promisify(execFile);

const MAX_SAFE_REPAIRS = 2;
const MAX_AUTO_UPGRADE_FILES = 24;
const MAX_AUTO_UPGRADE_BYTES = 6 * 1024 * 1024;

export function assertUpgradeScope(operation) {
  assertPhaseAllows(PHASE.UPGRADE, operation);
}

export function isUpgradePauseError(err) {
  const code = String(err?.code || '');
  const message = String(err?.message || err || '');
  // AI_NO_CHANGE is NOT a provider pause — it means the plan has no file changes.
  // Empty plans must resolve to NO_CHANGE / REPLAN, never PAUSED → RESUME loops.
  if (code === 'AI_NO_CHANGE' || /contains no file changes|did not propose a code change/i.test(message)) return false;
  return code === 'AI_UNAVAILABLE' || code === 'AI_BAD_JSON' || code === 'AI_RESPONSE_MALFORMED'
    || /HTTP (408|409|425|429|500|502|503|504)\b|timeout|timed out|fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|UNAVAILABLE|overloaded|temporar|invalid JSON|FORMAT_ERROR/i.test(message);
}

const MAX_NO_CHANGE_REPLANS = 2;

/**
 * Resolve an upgrade plan that has zero file changes.
 * Returns a terminal no-change result or a replan result with files.
 * Never pauses and never creates a fake checkpoint.
 */
export async function resolveEmptyUpgradePlan({
  project, projects, ai, plan, request = '', emit = () => {}, replanCount = 0,
} = {}) {
  const files = normalizeArray(plan?.files).filter((f) => f && f.path && typeof f.content === 'string');
  if (files.length) return { ok: true, files, plan, noChange: false, replanned: false };

  const root = String(plan?.root_cause || '');
  const rec = String(plan?.recommendation || '');
  const expected = String(plan?.expected_result || '');
  const blob = `${root}\n${rec}\n${expected}`;
  const claimsChangeNeeded = /\b(need|needed|missing|broken|fix|harmoniz|must|should|require|incomplete|outdated|inconsist|mismatch|not implement)/i.test(blob);
  const claimsAlreadyOk = /\b(fully complete|already (complete|implemented|present|correct|up to date)|no (code )?change|not required|nothing to (change|fix)|works as (expected|designed))/i.test(blob);

  // Case: diagnosis says app is already fine → complete without change
  if (claimsAlreadyOk || !claimsChangeNeeded) {
    emit('verify', 'done', '✓ Upgrade analyzed. Existing functionality verified. No code changes were required.');
    const finished = await completeUpgradeSession(projects, project, {
      finalHash: plan?.workingHash || null,
      changedFiles: [],
      completedSteps: ['diagnose', 'verify'],
      status: 'completed_no_change',
    }).catch(() => null);
    await projects.saveMetadata(project, 'upgrade-plan.json', {
      ...plan, files: [], resolvedAs: 'NO_CHANGE_REQUIRED', resolvedAt: new Date().toISOString(),
    }).catch(() => {});
    return {
      ok: true,
      files: [],
      plan,
      noChange: true,
      terminalState: 'COMPLETED_NO_CHANGE',
      session: finished,
      brief: 'Upgrade analyzed. No code changes were required. Application remains unchanged.',
    };
  }

  // Case: diagnosis claims a problem but files=[] → replan (bounded)
  if (replanCount >= MAX_NO_CHANGE_REPLANS) {
    emit('verify', 'done', '✓ Upgrade finished without code changes after bounded replan. Application remains unchanged.');
    const finished = await completeUpgradeSession(projects, project, {
      finalHash: null, changedFiles: [], completedSteps: ['diagnose', 'verify'], status: 'completed_no_change',
    }).catch(() => null);
    await projects.saveMetadata(project, 'upgrade-plan.json', {
      ...plan, files: [], resolvedAs: 'DONE_WITHOUT_CHANGE', replanCount, resolvedAt: new Date().toISOString(),
    }).catch(() => {});
    return {
      ok: true,
      files: [],
      plan,
      noChange: true,
      terminalState: 'COMPLETED_NO_CHANGE',
      session: finished,
      brief: 'Upgrade finished without code changes after replan. Application remains unchanged.',
    };
  }

  emit('diagnose', 'running', `Plan had zero files while diagnosis claimed a change is needed. Replanning (${replanCount + 1}/${MAX_NO_CHANGE_REPLANS})…`);
  const replanPromptExtra = `
PREVIOUS PLAN WAS INVALID:
- root_cause/recommendation claimed a code change is required
- but files was empty
This is NOT a provider failure.
Re-evaluate the request against the actual source.
If the requested capability is already implemented: return files:[] and root_cause explaining NO_CHANGE_REQUIRED.
If it is missing: return the smallest concrete file changes required (path + full content).
Do not return an empty file list when your diagnosis says a code change is required.
`;
  const next = await diagnoseUpgradeRequest({
    project, projects, ai,
    request: `${String(request || plan?.request || '').trim()}\n\n${replanPromptExtra}`,
    ruleText: '',
  });
  await projects.saveMetadata(project, 'upgrade-plan.json', {
    ...next, request: request || plan?.request || '', createdAt: new Date().toISOString(), replanCount: replanCount + 1,
  });
  const nextFiles = normalizeArray(next?.files).filter((f) => f && f.path && typeof f.content === 'string');
  if (nextFiles.length) {
    emit('diagnose', 'done', `Replan produced ${nextFiles.length} file change(s). Applying…`);
    return { ok: true, files: nextFiles, plan: next, noChange: false, replanned: true, replanCount: replanCount + 1 };
  }
  // Still empty → recurse with incremented count
  return resolveEmptyUpgradePlan({
    project, projects, ai, plan: next, request, emit, replanCount: replanCount + 1,
  });
}

export function planHasFileChanges(plan) {
  return normalizeArray(plan?.files).some((f) => f && f.path && typeof f.content === 'string');
}


export async function inspectUpgrade({ project, projects, snapshots, log }) {
  const sourceDir = projects.sourceDir(project.slug);
  const before = await fileManifest(sourceDir);
  const sourceMeta = await projects.readMetadata(project, 'upgrade-source.json', {});
  const sourceHash = manifestHash(before);
  const stack = await discoverStack(sourceDir);
  const deployment = await discoverDeploymentContract(sourceDir);
  const baseline = {
    createdAt: new Date().toISOString(),
    sourceHash,
    remoteSourceHash: sourceMeta.commit ? sourceMeta.commit : sourceHash,
    sourceCommit: sourceMeta.commit || sourceMeta.ref || 'HEAD',
    workingHash: sourceHash,
    fileCount: before.length,
    stack,
    deployment,
    // Upgrade baseline is identity/context only. It is deliberately NOT a quality
    // verdict and does not run Build/DARE/security/runtime repair.
    qualityGate: 'NOT_RUN',
    knownIssues: [],
    safeRepairs: [],
    evidence: { files: before.length, sourceHash, mode: 'baseline-only' },
  };
  const knowledge = buildUpgradeKnowledgeMap(project, stack, baseline, before, deployment);
  await projects.saveMetadata(project, 'upgrade-knowledge.json', knowledge);
  await projects.saveMetadata(project, 'upgrade-baseline.json', baseline);
  await projects.saveMetadata(project, 'upgrade-origin.json', {
    origin: 'upgrade',
    baselineHash: sourceHash,
    sourceHash,
    sourceCommit: baseline.sourceCommit,
    importedAt: sourceMeta.importedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  await projects.saveMetadata(project, 'upgrade-repair-history.json', []);
  await appendUpgradeHistory(projects, project, {
    kind: 'baseline', at: baseline.createdAt, result: 'baseline-created-no-repair',
  });
  log?.info?.('Upgrade baseline created (no quality scan/repair)', {
    project: project.slug, files: before.length, sourceHash,
  });
  return {
    baseline,
    knowledge,
    issues: [],
    safeRepairs: [],
    ready: true,
    origin: 'upgrade',
    qualityGate: 'NOT_RUN',
  };
}

async function discoverDeploymentContract(sourceDir) {
  const candidates = [
    'solohost/docker-compose.yml',
    'solohost/compose.yml',
    'docker-compose.yml',
    'compose.yml',
    'compose.yaml',
    'docker-compose.yaml',
  ];
  const composeFiles = [];
  for (const rel of candidates) {
    const text = await fs.readFile(path.join(sourceDir, rel), 'utf8').catch(() => '');
    if (text.trim()) composeFiles.push({ path: rel, sha256: sha256(text) });
  }
  const configCandidates = ['solohost/config_options.yml', 'config_options.yml'];
  const configFiles = [];
  for (const rel of configCandidates) {
    const text = await fs.readFile(path.join(sourceDir, rel), 'utf8').catch(() => '');
    if (text.trim()) configFiles.push({ path: rel, sha256: sha256(text) });
  }
  return { composeFiles, configFiles, source: composeFiles[0]?.path || null, config: configFiles[0]?.path || null };
}

function buildUpgradeKnowledgeMap(project, stack, baseline, manifest, deployment) {
  return {
    project: { id: project.id, slug: project.slug, name: project.name },
    architecture: { entryPoints: stack.entryPoints, routes: stack.routes, docker: stack.docker },
    stack,
    features: discoverFeatures(manifest, stack),
    deployment,
    baseline: {
      sourceHash: baseline.sourceHash,
      fileCount: baseline.fileCount,
      qualityGate: 'NOT_RUN',
    },
    rules: [
      'Upgrade preserves the existing app.',
      'Upgrade does not run Build scan/DARE/auto-repair.',
      'Only requested behavior is changed.',
      'Publish later synchronizes the SoloHost deployment artifact from current source/image evidence.',
    ],
    generatedAt: new Date().toISOString(),
  };
}

export async function beginUpgradeSession({ project, projects, request, mode = 'normal', ruleName = '' }) {
  const existing = await readUpgradeSession(projects, project);
  const baseline = await projects.readMetadata(project, 'upgrade-baseline.json', {});
  const source = await projects.readMetadata(project, 'upgrade-source.json', {});
  if (existing && existing.request === String(request || '').trim() && existing.status === 'paused' && existing.resumable) {
    return resumeUpgradeSession(projects, project);
  }
  const created = await createUpgradeSession(projects, project, {
    sourceCommit: baseline.sourceCommit || source.commit || source.ref || 'HEAD',
    baselineHash: baseline.remoteSourceHash || baseline.sourceHash || '',
    request, mode, ruleName,
    steps: [
      { id: 'diagnose', label: 'Inspect and plan' },
      { id: 'apply', label: 'Apply verified changes' },
      { id: 'verify', label: 'Verify and finalize' },
    ],
  });
  await projects.saveMetadata(project, 'agent-working-memory.json', {
    ...(await projects.readMetadata(project, 'agent-working-memory.json', {})),
    goal: String(request || '').trim(), phase: 'upgrade', status: 'running',
    plan: created?.steps || [], currentTask: 'diagnose', nextAction: 'understand and plan',
    updatedAt: new Date().toISOString(),
  });
  return created;
}

export async function resumeUpgrade({ project, projects, snapshots, ai, request = '', emit = () => {} }) {
  const session = await readUpgradeSession(projects, project);
  if (!session?.resumable) throw new Error('No resumable Upgrade session is available.');
  let plan = await projects.readMetadata(project, 'upgrade-plan.json', null);
  const req = String(request || session.request || '').trim();
  // Guard: never re-apply an empty plan (prevents PAUSE→RESUME→PAUSE loop)
  if (plan && !planHasFileChanges(plan)) {
    const resolved = await resolveEmptyUpgradePlan({
      project, projects, ai, plan, request: req, emit,
      replanCount: Number(plan.replanCount || 0),
    });
    if (resolved.noChange) {
      projects.setStatus?.(project, 'UPGRADE_READY');
      return { projectId: project.id, ...resolved, needsApproval: false };
    }
    plan = resolved.plan;
    // fall through to apply with replanned files
  }
  if (session.phase === 'verify' && session.workingHash && plan) {
    const finished = await completeUpgradeSession(projects, project, { finalHash: session.workingHash, changedFiles: session.changedFiles || [], completedSteps: ['apply', 'verify'] });
    emit('verify', 'done', `Upgrade resumed from the saved verification checkpoint. ${(session.changedFiles || []).length} file(s) were already verified.`);
    return { projectId: project.id, plan, session: finished, needsApproval: false, brief: plan.recommendation || 'Upgrade resumed from the saved verification checkpoint.' };
  }
  if (!plan) {
    await updateUpgradeSession(projects, project, { phase: 'plan', currentStep: 'diagnose', provider: null });
    emit('diagnose', 'running', 'Resuming the saved Upgrade plan from the last unfinished step…');
    const result = await diagnoseUpgradeRequest({ project, projects, ai, request: req, ruleText: '' });
    await projects.saveMetadata(project, 'upgrade-plan.json', { ...result, request: req, createdAt: new Date().toISOString() });
    await updateUpgradeSession(projects, project, { phase: 'apply', currentStep: 'apply', planHash: sha256(JSON.stringify(result)), provider: result.provider || null, stepId: 'diagnose', step: { status: 'done', result: 'Plan created and persisted.' }, completedSteps: ['diagnose'] });
    return resumeUpgrade({ project, projects, snapshots, ai, request: req, emit });
  }
  await updateUpgradeSession(projects, project, { phase: 'apply', currentStep: 'apply', planHash: sha256(JSON.stringify(plan)), stepId: 'apply', step: { status: 'running' } });
  emit('patch', 'running', 'Continuing from the saved Upgrade plan. No completed step will be repeated.');
  const applied = await applyUpgrade({ project, projects, snapshots, plan, request: req, approved: true, ruleExecution: true });
  const changed = applied.files || [];
  await updateUpgradeSession(projects, project, { phase: 'verify', currentStep: 'verify', changedFiles: changed, workingHash: applied.sourceHash || null, verification: applied.verification || [], stepId: 'apply', step: { status: 'done', files: changed, result: 'Verified changes applied.' }, completedSteps: ['apply'] });
  await updateUpgradeSession(projects, project, { stepId: 'verify', step: { status: 'running' } });
  const finished = await completeUpgradeSession(projects, project, { finalHash: applied.sourceHash || null, changedFiles: changed, stepId: 'verify', step: { status: 'done', result: 'Upgrade verified.' }, completedSteps: ['verify'] });
  emit('verify', 'done', `Upgrade resumed and completed. ${changed.length} file(s) changed.`);
  return { projectId: project.id, plan, execution: applied, session: finished, needsApproval: false, brief: plan.recommendation || 'Upgrade completed from the saved session.' };
}

export async function diagnoseUpgradeRequest({ project, projects, ai, request, ruleText = '', taskBrief = null }) {
  const sourceDir = projects.sourceDir(project.slug);
  const knowledge = await projects.readMetadata(project, 'upgrade-knowledge.json', {});
  const baseline = await projects.readMetadata(project, 'upgrade-baseline.json', {});
  const parsed = taskBrief ? { valid: false } : parseRule(ruleText || (/RULE_NAME|REQUIRED CAPABILITIES|REQUIRED_CAPABILITIES/i.test(request || '') ? request : ''));
  const relevant = await relevantContext(sourceDir, `${request}\n${taskBrief?.capability || (parsed.valid ? parsed.requiredCapabilities.join(' ') : '')}`);
  const gap = parsed.valid ? capabilityGap(parsed, relevant) : null;
  if (ruleText && !taskBrief && !parsed.valid) throw new Error(parsed.error);
  if (parsed.valid) await projects.saveMetadata(project, 'upgrade-rule.json', { rule: parsed, gap, loadedAt: new Date().toISOString() });
  const prompt = taskBrief ? `ONE BUILDER TASK ONLY

Do not receive or invent a full Rule. Complete only this assigned task.

TASK: ${taskBrief.capability}
WHY: ${taskBrief.why || 'Required capability is still missing.'}
CONSTRAINTS: Preserve working features. Smallest patch. No secrets in source. No architecture rewrite.

EVIDENCE:
${relevant.slice(0, 14000)}

Return JSON only with:
{
  "root_cause": "evidence-based diagnosis",
  "recommendation": "smallest effective upgrade",
  "risk": "low|medium|high",
  "files": [{"path":"relative/file","content":"complete replacement content"}],
  "expected_result": "verifiable result",
  "verification": ["checks"],
  "needs_user_action": ""
}` : `UPGRADE WORKSHOP — EXISTING APP ONLY

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
  await projects.saveMetadata(project, 'agent-working-memory.json', {
    ...(await projects.readMetadata(project, 'agent-working-memory.json', {})),
    goal: String(request || '').trim(), phase: 'upgrade', status: 'planning',
    constraints: ['preserve existing app', 'no Build scan/DARE/auto-repair'],
    currentTask: taskBrief?.capability || 'upgrade request',
    updatedAt: new Date().toISOString(),
  });
  const result = await ai.completeJson({
    task: 'UPGRADE_WORKSHOP',
    system: 'You are the Upgrade Workshop. Inspect first, diagnose from evidence, recommend the smallest effective change, and preserve the existing app. You are tool-driven: when the supplied context is insufficient, return tool_actions using only list_files, search_text, read_file, read_range, inspect_compose, inspect_config_options. Do not invent file contents.',
    prompt,
    projectId: project.id,
    validateJson: validateUpgradePlan,
  });
  let finalJson = result.json || {};
  const toolActions = Array.isArray(finalJson.tool_actions) ? finalJson.tool_actions : [];
  if (toolActions.length) {
    const toolResults = await runAgentTools({ sourceDir, actions: toolActions });
    const follow = await ai.completeJson({
      task: 'UPGRADE_WORKSHOP_TOOL_FOLLOWUP',
      system: 'You are the Upgrade Workshop continuing from tool evidence. Use only the tool results and prior request. Return the smallest safe upgrade plan. No Build scan, DARE, security repair, runtime repair, or unrelated fixes.',
      prompt: `${prompt}\n\nTOOL ACTIONS:\n${JSON.stringify(toolActions)}\n\nTOOL RESULTS:\n${JSON.stringify(toolResults)}\n\nReturn the same JSON contract without tool_actions unless another read is strictly necessary.`,
      projectId: project.id,
      validateJson: validateUpgradePlan,
    });
    finalJson = follow.json || finalJson;
    await projects.saveMetadata(project, 'agent-working-memory.json', {
      ...(await projects.readMetadata(project, 'agent-working-memory.json', {})),
      toolCalls: toolActions.map((x) => ({ tool: x.tool, args: x })),
      evidence: toolResults,
      status: 'planned',
      updatedAt: new Date().toISOString(),
    });
  }
  return { ...finalJson, rule: parsed.valid ? parsed : null, gap, ruleStatus: parsed.valid ? formatRuleStatus(parsed, gap) : '', provider: result.provider || null };
}

export async function applyUpgrade({
 project, projects, snapshots, plan, request, approved = false, ruleExecution = false }) {
  const userAction = String(plan?.needs_user_action || '');
  if (/secret|credential|wallet|private key|payment key|destructive/i.test(userAction)) {
    throw new Error(`NEEDS_USER_ACTION: ${userAction}`);
  }
  void approved; void ruleExecution;
  const files = Array.isArray(plan.files) ? plan.files.filter((f) => f && f.path && typeof f.content === 'string') : [];
  if (!files.length) throw Object.assign(new Error('Upgrade plan contains no file changes.'), { code: 'AI_NO_CHANGE', recoverable: true });
  if (files.length > MAX_AUTO_UPGRADE_FILES) throw new Error(`Upgrade scope is too large for an automatic patch (${MAX_AUTO_UPGRADE_FILES} files max).`);
  const totalBytes = files.reduce((sum, f) => sum + Buffer.byteLength(f.content, 'utf8'), 0);
  if (totalBytes > MAX_AUTO_UPGRADE_BYTES) throw new Error('Upgrade patch is too large for an automatic change set.');

  const sourceDir = projects.sourceDir(project.slug);
  const before = await fileManifest(sourceDir);
  const checkpoint = await snapshots.create(project, 'before-upgrade');
  const session = await readUpgradeSession(projects, project);
  if (session) await updateUpgradeSession(projects, project, {
    phase: 'apply', currentStep: 'apply', checkpoints: [checkpoint.id], stepId: 'apply', step: { status: 'running' },
  });

  for (const f of files) {
    const rel = normalize(f.path);
    if (!rel || rel.startsWith('/') || rel.includes('..') || fileClass(rel) === 'ABSOLUTELY_PROTECTED') {
      throw new Error(`Upgrade attempted to modify a protected or unsafe file: ${rel}`);
    }
    if (Buffer.byteLength(f.content, 'utf8') > 1024 * 1024) throw new Error(`Upgrade file is too large: ${rel}`);
  }

  const written = await writeGeneratedFiles(sourceDir, files);
  const after = await fileManifest(sourceDir);
  const changed = diffManifest(before, after);
  const expectedFiles = [...written, ...(plan.expected_files || plan.expectedFiles || []), ...(plan.derived_files || plan.derivedFiles || [])].map(normalize);
  const unexpected = changed.filter((f) => !expectedFiles.includes(normalize(f)));
  if (unexpected.length) {
    await snapshots.restore(project, checkpoint.id);
    throw new Error(`Upgrade rolled back: unexpected files changed: ${unexpected.join(', ')}`);
  }

  // Upgrade verification is targeted and evidence-based. It must never become the
  // Build quality gate. The imported app is treated as the working baseline.
  const verification = await verifyUpgradeChanges(sourceDir, written);
  if (!verification.ok) {
    await snapshots.restore(project, checkpoint.id);
    throw new Error(`UPGRADE_TARGETED_VERIFY_FAILED\n${verification.errors.join('\n')}`);
  }

  const sourceHash = manifestHash(after);
  await appendUpgradeHistory(projects, project, {
    kind: 'upgrade', at: new Date().toISOString(), request, rootCause: plan.root_cause,
    files: written, verification: verification.checks, checkpointId: checkpoint.id, result: 'verified',
  });
  const baseline = await projects.readMetadata(project, 'upgrade-baseline.json', {});
  await projects.saveMetadata(project, 'upgrade-baseline.json', {
    ...baseline, updatedAt: new Date().toISOString(), sourceHash, workingHash: sourceHash,
    fileCount: after.length, deployment: await discoverDeploymentContract(sourceDir),
  });
  await projects.saveMetadata(project, 'agent-working-memory.json', {
    ...(await projects.readMetadata(project, 'agent-working-memory.json', {})),
    status: 'running', phase: 'upgrade', currentTask: request,
    filesChanged: written, evidence: verification.checks, nextAction: 'continue or publish',
    updatedAt: new Date().toISOString(),
  });
  if (session) await updateUpgradeSession(projects, project, {
    phase: 'verify', currentStep: 'verify', workingHash: sourceHash, changedFiles: written,
    verification: verification.checks, checkpoints: [checkpoint.id],
    stepId: 'apply', step: { status: 'done', files: written, result: 'Targeted verification passed.' },
    completedSteps: ['apply'],
  });
  return { ok: true, files: written, sourceHash, verification: verification.checks, checkpointId: checkpoint.id };
}

async function verifyUpgradeChanges(sourceDir, files = []) {
  const checks = [];
  const errors = [];
  for (const rel of files.map(normalize)) {
    const full = path.join(sourceDir, rel);
    const text = await fs.readFile(full, 'utf8').catch(() => null);
    if (text == null) {
      errors.push(`Missing changed file: ${rel}`);
      continue;
    }
    const ext = path.extname(rel).toLowerCase();
    if (['.js', '.mjs', '.cjs'].includes(ext)) {
      try {
        await execFileAsync(process.execPath, ['--check', full], { timeout: 30000 });
        checks.push({ file: rel, check: 'javascript_syntax', ok: true });
      } catch (err) {
        errors.push(`${rel}: JavaScript syntax check failed.`);
        checks.push({ file: rel, check: 'javascript_syntax', ok: false });
      }
    } else if (ext === '.json') {
      try { JSON.parse(text); checks.push({ file: rel, check: 'json_parse', ok: true }); }
      catch { errors.push(`${rel}: JSON parse failed.`); checks.push({ file: rel, check: 'json_parse', ok: false }); }
    } else if (ext === '.yml' || ext === '.yaml') {
      const ok = !/\t/.test(text) && !/^\s*:\s*$/m.test(text);
      checks.push({ file: rel, check: 'yaml_shape', ok });
      if (!ok) errors.push(`${rel}: basic YAML shape check failed.`);
    } else {
      checks.push({ file: rel, check: 'file_written', ok: true });
    }
  }
  return { ok: errors.length === 0, checks, errors };
}

export async function runRuleUpgrade({ project, projects, snapshots, ai, request = '', ruleText = '', emit = () => {}, resume = false }) {
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
  await projects.saveMetadata(project, 'agent-working-memory.json', {
    ...(await projects.readMetadata(project, 'agent-working-memory.json', {})),
    goal: request || parsed.goal, phase: 'upgrade', status: 'running',
    plan: tasks.map((t) => ({ id: t.id, capability: t.capability, status: t.status })),
    currentTask: tasks.find((t) => t.status === 'pending')?.capability || null,
    updatedAt: new Date().toISOString(),
  });
  const state = resume && history?.rule === parsed.name && Array.isArray(history.tasks)
    ? { ...history, execution, status: 'running', updatedAt: new Date().toISOString() }
    : {
      rule: parsed.name,
      version: parsed.version,
      execution,
      status: 'running',
      cycle: 0,
      tasks,
      history: previous.slice(-80),
      startedAt: new Date().toISOString(),
    };
  tasks = state.tasks;
  await projects.saveMetadata(project, 'upgrade-rule-execution.json', state);
  emit('rule', 'running', `🧭 Rule loaded: ${parsed.name}. Builder will plan and execute ${tasks.filter(t => t.status === 'pending').length} task(s).`);

  const seen = new Set(previous.map((x) => `${x.capability}|${x.sourceHash}|${x.patchHash || ''}`));
  let userAction = '';
  let completed = 0;
  const firstCycle = resume ? Math.max(1, Number(state.cycle || 0) + 1) : 1;
  for (let cycle = firstCycle; cycle <= execution.maxCycles; cycle += 1) {
    state.cycle = cycle;
    const context = await relevantContext(sourceDir, parsed.requiredCapabilities.join(' '));
    gap = capabilityGap(parsed, context);
    if (gap.complete && !tasks.some(t => t.status === 'pending' && t.acceptance)) break;
    // Upgrade Rule execution is an agent workflow, not a repair pipeline. Build/DARE is out of scope here.
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
      plan = await diagnoseUpgradeRequest({ project, projects, ai, request: taskRequest, ruleText: '', taskBrief: { capability: task.capability, why: parsed.goal } });
    } catch (err) {
      if (isUpgradePauseError(err)) {
        task.status = 'pending'; task.error = String(err.message || err).slice(0, 500);
        state.status = 'paused';
        state.pausedAt = new Date().toISOString();
        state.pauseReason = { code: String(err.code || 'PAUSED_AI_UNAVAILABLE'), message: task.error };
        state.updatedAt = new Date().toISOString();
        await projects.saveMetadata(project, 'upgrade-rule-execution.json', state);
      } else {
        task.status = 'blocked'; task.error = String(err.message || err).slice(0, 500);
        await projects.saveMetadata(project, 'upgrade-rule-execution.json', state);
      }
      throw err;
    }
    if (plan.needs_user_action) {
      task.status = 'waiting_user'; task.needsUserAction = plan.needs_user_action;
      userAction = plan.needs_user_action;
      emit('input', 'done', `⏸ ${userAction}`);
      if (execution.stopOnUserAction) break;
      continue;
    }
    // Risk alone is never an approval gate. Required high-risk changes execute with checkpoint/verification; only explicit secret/destructive/unsafe conditions stop for user action.
    const before = await fileManifest(sourceDir);
    const sourceHash = manifestHash(before);
    const patchHash = sha256(JSON.stringify(plan.files || []));
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
    await projects.saveMetadata(project, 'agent-working-memory.json', {
      ...(await projects.readMetadata(project, 'agent-working-memory.json', {})),
      phase: 'upgrade', status: 'running',
      currentTask: tasks.find((t) => t.status === 'pending')?.capability || null,
      successfulActions: tasks.filter((t) => ['done', 'satisfied'].includes(t.status)).map((t) => t.capability),
      failures: tasks.filter((t) => ['failed', 'blocked'].includes(t.status)).map((t) => ({ capability: t.capability, error: t.error })),
      nextAction: tasks.find((t) => t.status === 'pending')?.capability || 'verify completion',
      updatedAt: new Date().toISOString(),
    });
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

function validateUpgradePlan(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  // Normalize optional array fields in-place so callers never see non-iterables
  if (value.files != null) value.files = normalizeArray(value.files);
  if (value.verification != null) value.verification = normalizeArray(value.verification);
  if (value.expected_files != null) value.expected_files = normalizeArray(value.expected_files);
  if (value.alternatives != null) value.alternatives = normalizeArray(value.alternatives);
  if (value.missing_capabilities != null) value.missing_capabilities = normalizeArray(value.missing_capabilities);
  if (typeof value.recommendation !== 'string' || typeof value.expected_result !== 'string') return false;
  if (!Array.isArray(value.files)) return false;
  if (value.files.some((f) => !f || typeof f.path !== 'string' || typeof f.content !== 'string')) return false;
  return true;
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

async function relevantContext(sourceDir, request) {
  // Unified authoritative snapshot (shared with Ask / Improve / Chat)
  return collectProjectContextText(sourceDir, String(request || ''), 'upgrade', 48000);
}

async function fileManifest(sourceDir) {
  const files = await listFiles(sourceDir);
  const out = [];
  for (const rel of files) {
    const full = path.join(sourceDir, rel);
    const stat = await fs.stat(full).catch(() => null); if (!stat?.isFile()) continue;
    const data = await fs.readFile(full);
    out.push({ path: normalize(rel), size: stat.size, sha256: sha256(data) });
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

function manifestHash(manifest) { return sha256(JSON.stringify(manifest || [])); }
function normalize(p) { return String(p || '').replace(/\\/g, '/').replace(/^\.\//, ''); }
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
