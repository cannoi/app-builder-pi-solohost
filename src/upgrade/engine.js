import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { listFiles, readJson } from '../utils/fsx.js';
import { scanProject } from '../security/scanner.js';
import { runStaticTests, runNodeTests, runSyntaxChecks, runProjectBuild } from '../testing/engine.js';
import { runDare } from '../dare/engine.js';
import { findMissingNodeModules } from '../projects/deps-fix.js';
import { writeGeneratedFiles } from '../projects/generator.js';
import { sourceFingerprint } from '../projects/source-version.js';
import { parseRule, capabilityGap, formatRuleStatus, buildRuleTasks, normalizeExecution } from './rules.js';
import { languageInstruction } from '../ai/language.js';
import { isProtectedFilePath } from '../security/policy.js';
import { redactAiContext } from '../utils/mask.js';
import { createRepairOperation, transitionRepairOperation, finishRepairOperation, persistRepairOperation } from '../jobs/loop-guard.js';

const MAX_SAFE_REPAIRS = 2;
const MAX_AI_REPAIRS = 2;

export async function inspectUpgrade({ project, projects, snapshots, log, validateRuntime = null, jobId = null }) {
  const sourceDir = projects.sourceDir(project.slug);
  const operation = createRepairOperation({ jobId, projectId: project.id, kind: 'upgrade-inspection' });
  operation.workspace_hash_before = await sourceFingerprint(sourceDir);
  await persistRepairOperation(projects, project, operation);
  transitionRepairOperation(operation, 'DIAGNOSE', { source_hash: operation.workspace_hash_before });
  let state = await inspectState(sourceDir);
  const stack = state.stack;

  const safeRepairs = [];
  let repairHistory = await projects.readMetadata(project, 'upgrade-repair-history.json', []);
  for (let attempt = 0; attempt < MAX_SAFE_REPAIRS; attempt += 1) {
    // Upgrade inspection must include the SoloHost runtime contract even when
    // source-level tests are green. A non-root Docker image can pass Node tests
    // and still crash at startup on SoloHost (for example EACCES /app/data).
    const candidate = await hasDeterministicCandidate(sourceDir);
    if (!candidate && attempt > 0) break;
    const repairBefore = await fileManifest(sourceDir);
    const checkpoint = await snapshots.create(project, `before-upgrade-safe-${attempt + 1}`);
    transitionRepairOperation(operation, 'EVIDENCE', { source_hash: manifestHash(repairBefore), candidate });
    const issueIds = state.issues.filter((issue) => issue.id !== 'healthy').map((issue) => issue.id).sort();
    operation.fingerprint = issueIds.length
      ? `INSPECTION_FINDINGS:${crypto.createHash('sha256').update(JSON.stringify(issueIds)).digest('hex').slice(0, 24)}`
      : 'NO_FAILURE_EVIDENCE';
    operation.fingerprint_history.push({ cycle: attempt + 1, fingerprint: operation.fingerprint, workspace_hash: manifestHash(repairBefore) });
    transitionRepairOperation(operation, 'FINGERPRINT', { fingerprint: operation.fingerprint });
    transitionRepairOperation(operation, 'DARE', { source_hash: manifestHash(repairBefore) });
    await persistRepairOperation(projects, project, operation);
    const repair = await runDare({
      sourceDir,
      logs: 'Upgrade preflight deterministic inspection.',
      extra: { message: 'SOLOHOST_UPGRADE_PREFLIGHT' },
      history: repairHistory,
    });
    if (repair?.fingerprint && repair.fingerprint !== operation.fingerprint) {
      operation.fingerprint = repair.fingerprint;
      operation.fingerprint_history.push({ cycle: attempt + 1, fingerprint: repair.fingerprint, workspace_hash: manifestHash(repairBefore) });
    }
    transitionRepairOperation(operation, 'DARE_RESULT', { fingerprint: repair?.fingerprint || null, status: repair?.ok ? 'changed' : 'no_change' });
    await persistRepairOperation(projects, project, operation);
    if (!repair?.ok) {
      if (repair?.stopped || repair?.next === 'AI' || repair?.next === 'USER_ACTION') break;
      break;
    }
    const after = await fileManifest(sourceDir);
    const changed = diffManifest(repairBefore, after);
    operation.fingerprint = repair.fingerprint || operation.fingerprint || null;
    operation.fingerprint_history.push({ cycle: attempt + 1, fingerprint: repair.fingerprint || 'NO_CHANGE', workspace_hash: manifestHash(repairBefore), after_hash: manifestHash(after) });
    operation.actual_changed_files = changed;
    operation.workspace_hash_after = await sourceFingerprint(sourceDir);
    if (!changed.length) break;
    const allowed = new Set((repair.files || []).map(normalize));
    const unexpected = changed.filter((f) => !allowed.has(normalize(f)));
    if (unexpected.length) {
      await snapshots.restore(project, checkpoint.id);
      throw new Error(`Upgrade safety check stopped: unexpected files changed: ${unexpected.join(', ')}`);
    }
    const afterState = await inspectState(sourceDir, {
      installDependencies: dependencyManifestChanged(repairBefore, after),
    });
    const runtime = validateRuntime ? await validateRuntime(project) : null;
    const regression = verificationRegressed(verificationSummary(state), verificationSummary(afterState));
    if (afterState.buildResult.status === 'failed') regression.push('Build failed after the deterministic repair.');
    if (validateRuntime && (runtime?.status !== 'passed' || runtime?.health !== true)) regression.push('Start/health/HTTP/smoke verification failed after the deterministic repair.');
    if (regression.length) {
      log?.warn?.('Upgrade deterministic repair regressed verification', { regression, before: verificationSummary(state), after: verificationSummary(afterState) });
      await snapshots.restore(project, checkpoint.id);
      break;
    }
    const entry = {
      at: new Date().toISOString(), fingerprint: repair.fingerprint, ruleId: repair.ruleId,
      files: repair.files || [], reason: repair.reason, checkpointId: checkpoint.id,
      beforeHash: manifestHash(repairBefore), afterHash: manifestHash(after),
    };
    repairHistory = [...repairHistory, entry].slice(-20);
    safeRepairs.push(entry);
    state = afterState;
    // Re-run DARE against the new source state. History prevents a repeat patch.
  }

  await projects.saveMetadata(project, 'upgrade-repair-history.json', repairHistory);
  const after = await fileManifest(sourceDir);
  state.health.fileCount = after.length;
  const knowledge = buildKnowledgeMap(project, stack, state, after, safeRepairs);
  const baseline = {
    createdAt: new Date().toISOString(),
    sourceHash: manifestHash(after),
    fileCount: after.length,
    githubSource: await projects.readMetadata(project, 'upgrade-source.json', null),
    stack,
    health: state.health,
    security: summarizeSecurity(state.security),
    knownIssues: state.issues,
    safeRepairs,
    verification: verificationSummary(state),
    evidence: { static: state.staticResult.status, node: state.nodeResult.status, syntax: state.syntaxResult.status, build: state.buildResult.status },
  };
  await projects.saveMetadata(project, 'upgrade-knowledge.json', knowledge);
  await projects.saveMetadata(project, 'upgrade-baseline.json', baseline);
  await appendUpgradeHistory(projects, project, {
    kind: 'inspect', at: baseline.createdAt, result: 'baseline-created', safeRepairs,
  });
  finishRepairOperation(operation, 'DONE', {
    workspace_hash_before: operation.workspace_hash_before,
    workspace_hash_after: await sourceFingerprint(sourceDir),
    changed_files: operation.actual_changed_files || [],
    verification: baseline.verification,
    safe_repairs: safeRepairs.length,
  });
  await persistRepairOperation(projects, project, operation);
  log?.info?.('Upgrade baseline created', { project: project.slug, files: after.length, safeRepairs: safeRepairs.length });
  return { baseline, knowledge, issues: state.issues, safeRepairs, ready: true, operationId: operation.operation_id, terminalState: operation.terminal_state };
}

export async function diagnoseUpgradeRequest({ project, projects, ai, request, ruleText = '', taskBrief = null, verificationFailure = null }) {
  const sourceDir = projects.sourceDir(project.slug);
  const knowledge = await projects.readMetadata(project, 'upgrade-knowledge.json', {});
  const baseline = await projects.readMetadata(project, 'upgrade-baseline.json', {});
  const parsed = taskBrief ? { valid: false } : parseRule(ruleText || (/RULE_NAME|REQUIRED CAPABILITIES|REQUIRED_CAPABILITIES/i.test(request || '') ? request : ''));
  const safeRequest = redactAiContext(request);
  const relevant = await relevantContext(sourceDir, `${safeRequest}\n${taskBrief?.capability || (parsed.valid ? parsed.requiredCapabilities.join(' ') : '')}`);
  const gap = parsed.valid ? capabilityGap(parsed, relevant) : null;
  if (ruleText && !taskBrief && !parsed.valid) throw new Error(parsed.error);
  if (parsed.valid) await projects.saveMetadata(project, 'upgrade-rule.json', { rule: parsed, gap, loadedAt: new Date().toISOString() });
  const prompt = taskBrief ? `${languageInstruction(request)}
ONE BUILDER TASK ONLY

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
}` : `${languageInstruction(request)}
UPGRADE WORKSHOP — EXISTING APP ONLY

Preserve the existing application. Do not redesign or regenerate it.

APP KNOWLEDGE MAP:
${JSON.stringify(knowledge)}

BASELINE:
${JSON.stringify(baseline)}

EXISTING CHECK FINDINGS:
${JSON.stringify(baseline.verification || baseline.knownIssues || {})}

RULE:
${parsed.valid ? JSON.stringify({ name: parsed.name, goal: parsed.goal, required: parsed.requiredCapabilities, missing: gap?.missingCapabilities || [], secrets: parsed.secrets }) : 'No structured rule. Treat the user text as a normal upgrade request.'}

USER REQUEST:
${safeRequest}

${verificationFailure ? `${verificationFailure.sourceChanged
  ? 'PROJECT SOURCE CHANGED WHILE THE PLAN WAS BEING PREPARED; no patch was written.'
  : 'LAST PATCH DID NOT VERIFY (it was rolled back):'}
${JSON.stringify(verificationFailure)}
Diagnose this evidence and produce a fresh, smallest effective plan. Do not repeat a failed patch or hide/disable the failing checks.` : ''}

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
  "completion_message": "short verified-result message in the user's language",
  "missing_capabilities": [],
  "needs_user_action": "",
  "alternatives": [{"name":"...","risk":"...","scope":"..."}]
}
Rules: achieve the user's requested outcome, not merely describe a repair. Also fix confirmed pre-existing syntax, test, and security findings when safe and within the request's scope. Do not invent facts; do not propose dependency-wide upgrades; do not modify secrets, credentials, database schema, auth, payment, wallet, or Docker architecture unless explicitly required and marked high risk. Keep the patch limited to files needed for the request or confirmed findings, and preserve all unrelated behavior. If a required credential, destructive action, or decision cannot be safely inferred, set needs_user_action instead of guessing.`;
  const result = await ai.completeJson({ task: 'UPGRADE_WORKSHOP', system: 'You are the Upgrade Workshop. Inspect first, diagnose from evidence, recommend the smallest effective change, and preserve the existing app.', prompt: redactAiContext(prompt), projectId: project.id });
  return { ...(result.json || {}), rule: parsed.valid ? parsed : null, gap, ruleStatus: parsed.valid ? formatRuleStatus(parsed, gap) : '' };
}

export async function applyUpgrade({ project, projects, snapshots, plan, request, approved = false, ruleExecution = false, operation = null, validateRuntime = null, emit = () => {} }) {
  const ownsOperation = !operation;
  operation ||= createRepairOperation({ projectId: project.id, kind: ruleExecution ? 'rule-upgrade' : 'upgrade-apply', request: redactAiContext(request) });
  await persistRepairOperation(projects, project, operation);
  const risk = String(plan?.risk || 'high').toLowerCase();
  const stopBeforePatch = async (message, code, terminalState = 'BLOCKED') => {
    if (ownsOperation) {
      finishRepairOperation(operation, terminalState, { error: message });
      await persistRepairOperation(projects, project, operation);
    }
    const err = new Error(message);
    err.code = code;
    throw err;
  };
  const needsUserAction = async (message) => {
    return stopBeforePatch(message, 'NEEDS_USER_ACTION', 'NEEDS_USER_ACTION');
  };
  // Explicitly requested autonomous upgrades pass approved=true. Direct callers
  // without that user intent still need an explicit confirmation for risky work.
  if (risk === 'high' && !approved) await needsUserAction('NEEDS_USER_ACTION: High-risk upgrade needs an explicit review.');
  if (!ruleExecution && risk !== 'low' && risk !== 'medium' && !approved) await needsUserAction('NEEDS_USER_ACTION: Upgrade plan is not low risk. Review and approve the change before applying it.');
  if (!ruleExecution && risk === 'medium' && !approved) await needsUserAction('NEEDS_USER_ACTION: Medium-risk upgrade needs your Apply confirmation.');
  if (ruleExecution && risk === 'medium' && plan?.needs_user_action) await needsUserAction(`NEEDS_USER_ACTION: ${plan.needs_user_action}`);
  const files = Array.isArray(plan.files)
    ? plan.files.filter((f) => f && f.path && typeof f.content === 'string').map((f) => ({ ...f, path: normalize(f.path) }))
    : [];
  if (!files.length) {
    if (ownsOperation) {
      finishRepairOperation(operation, 'NO_CHANGE', { reason: 'Upgrade plan contains no file changes.' });
      await persistRepairOperation(projects, project, operation);
    }
    const err = new Error('Upgrade plan contains no file changes.');
    err.code = 'NO_CHANGE';
    throw err;
  }
  if (files.length > 8) await needsUserAction('NEEDS_USER_ACTION: Upgrade scope is too large for an automatic minimal patch.');
  const sourceDir = projects.sourceDir(project.slug);
  const before = await fileManifest(sourceDir);
  const baseline = await projects.readMetadata(project, 'upgrade-baseline.json', {});
  operation.github_source = baseline.githubSource ? {
    owner: baseline.githubSource.owner,
    repo: baseline.githubSource.repo,
    branch: baseline.githubSource.branch,
    commit_sha: baseline.githubSource.commitSha,
    source_hash: baseline.githubSource.sourceHash,
  } : null;
  if (baseline?.sourceHash && baseline.sourceHash !== manifestHash(before)) {
    await stopBeforePatch('Upgrade baseline is stale because project files changed after inspection.', 'UPGRADE_BASELINE_STALE', 'NEEDS_USER_ACTION');
  }
  const paths = new Set();
  for (const f of files) {
    const rel = normalize(f.path);
    if (isProtectedFilePath(rel) || rel.includes('\0')) {
      const err = new Error(`Upgrade attempted to modify a protected or unsafe file: ${rel}`);
      err.code = 'PATCH_PROTECTED_FILE';
      transitionRepairOperation(operation, 'REJECT_PATCH', { fingerprint: `PROTECTED_FILE_TARGET:${rel}`, target: rel });
      finishRepairOperation(operation, 'BLOCKED', { fingerprint: `PROTECTED_FILE_TARGET:${rel}` });
      await persistRepairOperation(projects, project, operation);
      throw err;
    }
    if (Buffer.byteLength(f.content, 'utf8') > 1024 * 1024) await stopBeforePatch(`Upgrade file is too large: ${rel}`, 'PATCH_REJECTED');
    if (paths.has(rel)) await stopBeforePatch(`Upgrade plan contains the same file more than once: ${rel}`, 'PATCH_REJECTED');
    paths.add(rel);
  }
  if (typeof validateRuntime !== 'function') {
    await needsUserAction('NEEDS_USER_ACTION: A live runtime validator is required before an Upgrade can be marked complete.');
  }
  const checkpoint = await snapshots.create(project, 'before-upgrade');
  const checkpointSource = await fileManifest(sourceDir);
  if (manifestHash(checkpointSource) !== manifestHash(before)) {
    await stopBeforePatch('Upgrade baseline became stale while the rollback checkpoint was being created.', 'UPGRADE_BASELINE_STALE', 'NEEDS_USER_ACTION');
  }
  const beforeWorkspaceHash = await sourceFingerprint(sourceDir);
  operation.workspace_hash_before = beforeWorkspaceHash;
  operation.proposed_files = [...paths];
  transitionRepairOperation(operation, 'PREFLIGHT', { workspace_hash: beforeWorkspaceHash, proposed_files: operation.proposed_files });
  await persistRepairOperation(projects, project, operation);
  let changedFiles;
  let after;
  let verified;
  let runtimeResult = null;
  try {
    transitionRepairOperation(operation, 'APPLY', { before_hash: beforeWorkspaceHash, proposed_files: [...paths] });
    await persistRepairOperation(projects, project, operation);
    await writeGeneratedFiles(sourceDir, files);
    after = await fileManifest(sourceDir);
    changedFiles = diffManifest(before, after);
    operation.actual_changed_files = changedFiles;
    operation.workspace_hash_after = await sourceFingerprint(sourceDir);
    const unexpected = changedFiles.filter((f) => !paths.has(normalize(f)));
    if (unexpected.length) {
      const err = new Error(`Upgrade rolled back: unexpected files changed: ${unexpected.join(', ')}`);
      err.code = 'PATCH_OUT_OF_SCOPE';
      err.upgradeVerification = { changedFiles, unexpectedFiles: unexpected };
      throw err;
    }
    if (!changedFiles.length) {
      const err = new Error('Upgrade plan did not change any source files.');
      err.code = 'NO_CHANGE';
      throw err;
    }
    transitionRepairOperation(operation, 'VALIDATE', { changed_files: changedFiles, workspace_hash: operation.workspace_hash_after });
    await persistRepairOperation(projects, project, operation);
    emit('validating', 'running', 'Checking the changed files, app tests, security and build against the latest source…');
    const syntax = await runSyntaxChecks(sourceDir, changedFiles);
    if (syntax.status === 'failed') throw verificationError('Changed JavaScript failed syntax validation.', { syntax, changedFiles });
    verified = await inspectState(sourceDir, {
      installDependencies: changedFiles.some((file) => /(^|\/)(?:package\.json|package-lock\.json|npm-shrinkwrap\.json)$/.test(file)),
      syntaxFiles: changedFiles,
      precheckedSyntax: syntax,
    });
    verified.syntaxResult = mergeChangedSyntax(baseline.verification?.syntax, syntax, changedFiles);
    const regression = verificationRegressed(baseline.verification, verificationSummary(verified), changedFiles);
    if (regression.length) throw verificationError('Upgrade failed final verification and was rolled back.', {
      changedFiles,
      regression,
      verification: verificationSummary(verified),
    });
    if (verified.buildResult.status === 'failed') throw verificationError('Upgrade build failed and was rolled back.', {
      changedFiles, regression: ['Project build failed.'], verification: verificationSummary(verified),
    });
    if (validateRuntime) {
      emit('testing', 'running', 'Starting the updated app and checking health, HTTP and browser behavior…');
      transitionRepairOperation(operation, 'START', { status: 'running' });
      await persistRepairOperation(projects, project, operation);
      runtimeResult = await validateRuntime(project);
      transitionRepairOperation(operation, 'SMOKE_TEST', { status: runtimeResult?.e2e?.status || 'skipped' });
      transitionRepairOperation(operation, 'HTTP_TEST', { status: runtimeResult?.health === true ? 'passed' : 'failed', source_hash: runtimeResult?.sourceHash || null });
      operation.validation = {
        ...verificationSummary(verified),
        runtime: {
          status: runtimeResult?.status,
          health: runtimeResult?.health === true,
          http: runtimeResult?.health === true ? 'passed' : 'failed',
          e2e: runtimeResult?.e2e?.status || 'skipped',
          preview: runtimeResult?.previewPath ? 'passed' : 'failed',
          sourceHash: runtimeResult?.sourceHash || null,
        },
      };
      await persistRepairOperation(projects, project, operation);
      if (runtimeResult?.status !== 'passed' || runtimeResult?.health !== true
        || runtimeResult?.e2e?.status !== 'passed' || !runtimeResult?.previewPath
        || runtimeResult?.sourceHash !== operation.workspace_hash_after) throw verificationError('Upgrade start/health/HTTP/browser-preview validation failed and was rolled back.', {
        changedFiles, regression: ['Runtime validation failed.'], verification: operation.validation,
      });
      emit('preview', 'done', `Preview and browser smoke test passed at ${runtimeResult.previewPath}.`);
    }
  } catch (err) {
    try {
      transitionRepairOperation(operation, 'ROLLBACK', { error: redactAiContext(err.message || err) });
      await snapshots.restore(project, checkpoint.id);
      const restoredHash = await sourceFingerprint(sourceDir);
      operation.rollback = { expected_hash: beforeWorkspaceHash, restored_hash: restoredHash, verified: restoredHash === beforeWorkspaceHash };
      await persistRepairOperation(projects, project, operation);
      if (restoredHash !== beforeWorkspaceHash) throw new Error('Rollback verification failed: workspace hash did not return to its pre-patch value.');
    } catch (rollbackErr) {
      throw new Error(`Upgrade failed (${String(err.message || err)}); rollback also failed (${String(rollbackErr.message || rollbackErr)}).`);
    }
    if (err.upgradeVerification) err.upgradeVerification.rolledBack = true;
    if (ownsOperation) {
      finishRepairOperation(operation, err.code === 'PATCH_PROTECTED_FILE' ? 'BLOCKED'
        : err.code === 'NO_CHANGE' ? 'NO_CHANGE'
          : err.code === 'NEEDS_USER_ACTION' ? 'NEEDS_USER_ACTION' : 'ROLLED_BACK', {
        workspace_hash_after: await sourceFingerprint(sourceDir),
        rollback: operation.rollback || null,
        error: redactAiContext(err.message || err),
      });
      await persistRepairOperation(projects, project, operation);
    }
    throw err;
  }
  await appendUpgradeHistory(projects, project, {
    kind: 'upgrade', at: new Date().toISOString(), request, rootCause: plan.root_cause,
    files: changedFiles, verification: verified.health, checkpointId: checkpoint.id, result: 'verified',
  });
  const sourceHash = await sourceFingerprint(sourceDir);
  const previousTests = await projects.readMetadata(project, 'test-plan.json', {});
  await projects.saveMetadata(project, 'test-plan.json', {
    ...previousTests,
    staticResult: verified.staticResult,
    nodeResult: verified.nodeResult,
    scan: verified.security,
    sourceHash,
    preview: runtimeResult,
    dockerBuild: null,
    e2e: runtimeResult?.e2e || null,
    previewSourceHash: runtimeResult?.sourceHash || null,
    changedFiles,
    verification: verificationSummary(verified),
    verifiedAt: new Date().toISOString(),
  });
  await projects.saveMetadata(project, 'upgrade-baseline.json', {
    ...baseline, updatedAt: new Date().toISOString(), sourceHash: manifestHash(after),
    health: verified.health, security: summarizeSecurity(verified.security),
    knownIssues: verified.issues, verification: verificationSummary(verified),
  });
  operation.validation = { ...verificationSummary(verified), runtime: validateRuntime ? operation.validation?.runtime : { status: 'not_run' } };
  operation.workspace_hash_after = sourceHash;
  if (ownsOperation) finishRepairOperation(operation, 'DONE', { workspace_hash_after: sourceHash, changed_files: changedFiles, validation: operation.validation });
  await persistRepairOperation(projects, project, operation);
  return { ok: true, files: changedFiles, verification: verified.health, checkpointId: checkpoint.id, sourceHash, runtime: runtimeResult, operationId: operation.operation_id, terminalState: ownsOperation ? 'DONE' : null };
}

export async function executeUpgradeRequest({ project, projects, snapshots, ai, request, emit = () => {}, validateRuntime = null, jobId = null }) {
  const sourceDir = projects.sourceDir(project.slug);
  let baseline = await projects.readMetadata(project, 'upgrade-baseline.json', null);
  const operation = createRepairOperation({ jobId, projectId: project.id, kind: 'upgrade', request: redactAiContext(request) });
  const fail = async (err) => {
    finishRepairOperation(operation, 'FAILED', {
      error: redactAiContext(err.message || err),
      workspace_hash_after: await sourceFingerprint(sourceDir).catch(() => null),
    });
    await persistRepairOperation(projects, project, operation);
    throw err;
  };
  if (typeof validateRuntime !== 'function') {
    finishRepairOperation(operation, 'NEEDS_USER_ACTION', {
      error: 'A live runtime/preview validator is required before an Upgrade can be marked complete.',
      workspace_hash_after: await sourceFingerprint(sourceDir).catch(() => null),
    });
    await persistRepairOperation(projects, project, operation);
    return {
      projectId: project.id,
      status: 'needs_user_action',
      terminalState: 'NEEDS_USER_ACTION',
      needsUserAction: 'The live preview validator is unavailable, so the Upgrade cannot be safely completed.',
      brief: '⏸ No patch was applied because this environment cannot verify start, HTTP health, browser behavior and preview against the updated files.',
      operationId: operation.operation_id,
    };
  }
  if (!baseline) {
    let inspection;
    try {
      inspection = await inspectUpgrade({ project, projects, snapshots, validateRuntime, jobId });
    } catch (err) {
      return fail(err);
    }
    baseline = inspection.baseline;
  }
  if (!baseline.sourceHash || !baseline.verification || baseline.sourceHash !== manifestHash(await fileManifest(sourceDir))) {
    emit('inspect', 'running', 'Project files changed since the last inspection. Refreshing the baseline before upgrading…');
    let inspection;
    try {
      inspection = await inspectUpgrade({ project, projects, snapshots, validateRuntime, jobId });
    } catch (err) {
      return fail(err);
    }
    baseline = inspection.baseline;
  }
  operation.workspace_hash_before = await sourceFingerprint(sourceDir);
  operation.github_source = baseline.githubSource ? {
    owner: baseline.githubSource.owner,
    repo: baseline.githubSource.repo,
    branch: baseline.githubSource.branch,
    commit_sha: baseline.githubSource.commitSha,
    source_hash: baseline.githubSource.sourceHash,
  } : null;
  await persistRepairOperation(projects, project, operation);
  const step = async (state, evidence = {}) => {
    transitionRepairOperation(operation, state, evidence);
    await persistRepairOperation(projects, project, operation);
    const stage = ({
      PREFLIGHT: 'inspecting',
      DIAGNOSE: 'planning',
      EVIDENCE: 'planning',
      FINGERPRINT: 'planning',
      DARE: 'planning',
      PLAN: 'planning',
      SAFETY_CHECK: 'upgrading',
      APPLY: 'upgrading',
      VALIDATE: 'validating',
      START: 'testing',
      SMOKE_TEST: 'testing',
      HTTP_TEST: 'testing',
    })[state] || state.toLowerCase();
    emit(stage, 'running', state);
  };
  const terminal = async (terminalState, result, evidence = {}) => {
    finishRepairOperation(operation, terminalState, evidence);
    await persistRepairOperation(projects, project, operation);
    return { ...result, operationId: operation.operation_id, terminalState };
  };

  let verificationFailure = null;
  for (let attempt = 0; attempt < MAX_AI_REPAIRS; attempt += 1) {
    operation.cycle = attempt + 1;
    await step('PREFLIGHT', { workspace_hash: await sourceFingerprint(sourceDir), attempt: attempt + 1 });
    emit('diagnose', 'running', attempt
      ? verificationFailure?.sourceChanged
        ? `Re-planning from the refreshed source (${attempt}/${MAX_AI_REPAIRS})…`
        : `Re-planning from the failed checks (${attempt}/${MAX_AI_REPAIRS}); the failed patch was rolled back…`
      : 'Matching your requested outcome to the current app and its inspection findings…');
    await step('DIAGNOSE', { source_hash: await sourceFingerprint(sourceDir), verification_failure: verificationFailure ? redactAiContext(JSON.stringify(verificationFailure)) : null });
    let plan;
    try {
      plan = await diagnoseUpgradeRequest({ project, projects, ai, request, verificationFailure });
    } catch (err) {
      return fail(err);
    }
    plan.sourceHash = baseline.sourceHash;
    plan.sourceCommit = baseline.githubSource?.commitSha || null;
    plan.beforeWorkspaceHash = await sourceFingerprint(sourceDir);
    await step('EVIDENCE', { baseline_hash: baseline.sourceHash, issue_count: baseline.knownIssues?.length || 0 });
    operation.fingerprint = String(verificationFailure?.fingerprint || baseline.knownIssues?.[0]?.id || 'UPGRADE_OBJECTIVE');
    operation.fingerprint_history.push({ cycle: attempt + 1, fingerprint: operation.fingerprint, workspace_hash: await sourceFingerprint(sourceDir), validation_hash: verificationFailure?.validationHash || null });
    await projects.saveMetadata(project, 'upgrade-plan.json', {
      ...plan, request, attempt: attempt + 1, createdAt: new Date().toISOString(),
    });
    if (plan.needs_user_action) {
      await projects.saveMetadata(project, 'upgrade-plan.json', {
        ...plan, request, status: 'needs_user_action', attempt: attempt + 1,
        createdAt: new Date().toISOString(),
      });
      return terminal('NEEDS_USER_ACTION', {
        projectId: project.id, status: 'needs_user_action', needsUserAction: plan.needs_user_action,
        plan, brief: `⏸ I need one decision before I can safely complete this upgrade: ${plan.needs_user_action}`,
      }, { fingerprint: operation.fingerprint });
    }
    const files = Array.isArray(plan.files) ? plan.files : [];
    if (!files.length) {
      await projects.saveMetadata(project, 'upgrade-plan.json', {
        ...plan, request, status: 'no_changes', attempt: attempt + 1,
        createdAt: new Date().toISOString(),
      });
      return terminal('NO_CHANGE', {
        projectId: project.id, status: 'no_changes', plan,
        brief: plan.recommendation || 'No source change was needed for this request. The existing app was left unchanged.',
      }, { fingerprint: operation.fingerprint, sourceHash: await sourceFingerprint(sourceDir) });
    }
    operation.ai_proposal = redactAiContext(JSON.stringify({ root_cause: plan.root_cause, recommendation: plan.recommendation, risk: plan.risk, expected_result: plan.expected_result, files: files.map((file) => file.path) }));
    operation.proposed_files = files.map((file) => normalize(file.path));
    await step('PLAN', { proposed_files: operation.proposed_files, reason: redactAiContext(plan.recommendation || ''), expected_effect: redactAiContext(plan.expected_result || '') });
    await step('SAFETY_CHECK', { proposed_files: operation.proposed_files });
    emit('upgrading', 'running', `Applying the smallest patch (${files.length} proposed file(s)); verification will check the actual changed files…`);
    try {
      const result = await applyUpgrade({
        project, projects, snapshots, plan, request,
        // The user explicitly requested this upgrade; ask only for decisions
        // the plan says cannot safely be inferred, not confirmation per edit.
        approved: true,
        operation, validateRuntime, emit,
      });
      const brief = `${plan.completion_message || '✓ Upgrade verified.'}\nFiles verified: ${result.files.join(', ')}`;
      emit('completed', 'done', brief);
      await projects.saveMetadata(project, 'upgrade-plan.json', {
        ...plan, request, status: 'verified', changedFiles: result.files,
        checkpointId: result.checkpointId,
        beforeSourceHash: plan.beforeWorkspaceHash,
        afterSourceHash: result.sourceHash,
        sourceCommit: baseline.githubSource?.commitSha || null,
        validation: result.runtime || result.verification,
        completedAt: new Date().toISOString(),
      });
      return terminal('DONE', {
        projectId: project.id, status: 'completed', upgrade: true, plan,
        files: result.files, verification: result.verification,
        checkpointId: result.checkpointId, attempts: attempt + 1, brief,
        sourceCommit: baseline.githubSource?.commitSha || null,
        beforeSourceHash: plan.beforeWorkspaceHash,
        afterSourceHash: result.sourceHash,
        runtime: result.runtime,
      }, { fingerprint: operation.fingerprint, changedFiles: result.files, workspaceHash: result.sourceHash, validation: operation.validation });
    } catch (err) {
      if (err.code === 'UPGRADE_BASELINE_STALE') {
        if (attempt === MAX_AI_REPAIRS - 1) {
          return terminal('NO_CHANGE', {
            projectId: project.id, status: 'stopped', plan, attempts: attempt + 1,
            brief: '⚠ The app changed while Upgrade was planning. No patch was written; inspect the latest source and send the request again.',
          }, { fingerprint: operation.fingerprint });
        }
        emit('inspect', 'running', 'The source changed while planning. Refreshing the baseline and re-reading the latest files…');
        let inspection;
        try {
          inspection = await inspectUpgrade({ project, projects, snapshots, validateRuntime, jobId });
        } catch (inspectErr) {
          return fail(inspectErr);
        }
        baseline = inspection.baseline;
        verificationFailure = { sourceChanged: true, message: err.message };
        continue;
      }
      if (err.code === 'PATCH_PROTECTED_FILE') {
        await projects.saveMetadata(project, 'upgrade-plan.json', { ...plan, request, status: 'blocked', terminalState: 'BLOCKED', error: redactAiContext(err.message) });
        return terminal('BLOCKED', { projectId: project.id, status: 'blocked', plan, brief: `⛔ ${err.message}` }, { fingerprint: operation.fingerprint });
      }
      if (!err.upgradeVerification) return fail(err);
      verificationFailure = {
        ...err.upgradeVerification,
        attempt: attempt + 1,
        planFiles: files.map((file) => normalize(file?.path)).filter(Boolean),
        fingerprint: operation.fingerprint,
        validationHash: crypto.createHash('sha256').update(JSON.stringify(err.upgradeVerification.verification || err.upgradeVerification)).digest('hex'),
      };
      await projects.saveMetadata(project, 'upgrade-plan.json', {
        ...plan, request, status: 'rolled_back', verificationFailure,
        completedAt: new Date().toISOString(),
      });
      emit('rollback', 'done', `Restored the checkpoint after verification failed in ${verificationFailure.changedFiles?.join(', ') || 'the proposed changes'}.`);
      const currentWorkspaceHash = manifestHash(await fileManifest(sourceDir));
      const priorFingerprint = operation.fingerprint_history[operation.fingerprint_history.length - 1];
      if (currentWorkspaceHash === baseline.sourceHash
        && verificationFailure.fingerprint === priorFingerprint?.fingerprint) {
        const brief = '⚠ Upgrade stopped after rollback. The workspace and validation baseline are unchanged, so another AI call would repeat the same repair without progress.';
        emit('verify', 'failed', brief);
        return terminal('ROLLED_BACK', { projectId: project.id, status: 'stopped', plan, verificationFailure, attempts: attempt + 1, brief }, verificationFailure);
      }
    }
  }
  const brief = 'Upgrade stopped after the bounded repair attempts. No unverified change was reported as complete.';
  return terminal('ROLLED_BACK', { projectId: project.id, status: 'stopped', verificationFailure, brief }, verificationFailure || {});
}

export async function runRuleUpgrade({ project, projects, snapshots, ai, request = '', ruleText = '', emit = () => {}, validateRuntime = null, jobId = null }) {
  const parsed = parseRule(ruleText || request);
  if (!parsed.valid) throw new Error(parsed.error);

  // Defensive normalization is intentional: old/custom Rules can contain
  // EXECUTION: null, missing maxCycles, strings, or extra parameters.
  const execution = normalizeExecution(parsed.execution);
  const sourceDir = projects.sourceDir(project.slug);
  const operation = createRepairOperation({ jobId, projectId: project.id, kind: 'rule-upgrade', request: redactAiContext(request) });
  operation.workspace_hash_before = await sourceFingerprint(sourceDir);
  const initialBaseline = await projects.readMetadata(project, 'upgrade-baseline.json', {});
  operation.github_source = initialBaseline.githubSource ? {
    owner: initialBaseline.githubSource.owner,
    repo: initialBaseline.githubSource.repo,
    branch: initialBaseline.githubSource.branch,
    commit_sha: initialBaseline.githubSource.commitSha,
    source_hash: initialBaseline.githubSource.sourceHash,
  } : null;
  await persistRepairOperation(projects, project, operation);
  if (typeof validateRuntime !== 'function') {
    finishRepairOperation(operation, 'NEEDS_USER_ACTION', {
      error: 'A live runtime/preview validator is required before a Rule Upgrade can be marked complete.',
      workspace_hash_after: await sourceFingerprint(sourceDir),
    });
    await persistRepairOperation(projects, project, operation);
    return {
      status: 'needs_user_action',
      needsUserAction: 'The live preview validator is unavailable, so this Rule Upgrade cannot be safely completed.',
      execution: { status: 'NEEDS_USER_ACTION', tasks: [] },
      operationId: operation.operation_id,
      terminalState: 'NEEDS_USER_ACTION',
    };
  }
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
  const attemptedEvidence = new Set();
  let userAction = '';
  let completed = 0;
  let cycle = 0;
  for (cycle = 1; cycle <= execution.maxCycles; cycle += 1) {
    operation.cycle = cycle;
    state.cycle = cycle;
    const context = await relevantContext(sourceDir, parsed.requiredCapabilities.join(' '));
    gap = capabilityGap(parsed, context);
    if (gap.complete && !tasks.some(t => t.status === 'pending' && t.acceptance)) break;
    if (await hasDeterministicCandidate(sourceDir)) {
      emit('repair', 'running', `🛠 Cycle ${cycle}/${execution.maxCycles}: Builder applying a proven local fix before asking AI.`);
      const dareBeforeHash = await sourceFingerprint(sourceDir);
      const dareCheckpoint = await snapshots.create(project, `before-rule-dare-${cycle}`);
      transitionRepairOperation(operation, 'DARE', { source_hash: dareBeforeHash });
      await persistRepairOperation(projects, project, operation);
      let dare;
      try {
        dare = await runDare({ sourceDir, logs: `Rule cycle ${cycle} deterministic pass.`, extra: { message: 'RULE_ENGINE_CYCLE' }, history: state.history });
      } catch (err) {
        await snapshots.restore(project, dareCheckpoint.id);
        const restoredHash = await sourceFingerprint(sourceDir);
        operation.rollback = { expected_hash: dareBeforeHash, restored_hash: restoredHash, verified: restoredHash === dareBeforeHash };
        finishRepairOperation(operation, operation.rollback.verified ? 'ROLLED_BACK' : 'FAILED', {
          error: redactAiContext(err.message || err),
          rollback: operation.rollback,
        });
        await persistRepairOperation(projects, project, operation);
        if (!operation.rollback.verified) throw new Error(`${String(err.message || err)}; Rule DARE rollback verification failed.`);
        throw err;
      }
      if (dare?.ok && !dare.alreadyFixed && Array.isArray(dare.files) && dare.files.length) {
        operation.fingerprint = dare.fingerprint || 'NO_FAILURE_EVIDENCE';
        operation.fingerprint_history.push({ cycle, source: 'DARE', fingerprint: operation.fingerprint, workspace_hash: dareBeforeHash });
        operation.proposed_files = dare.files.map(normalize);
        operation.actual_changed_files = dare.changed || [];
        operation.workspace_hash_after = await sourceFingerprint(sourceDir);
        const checks = await inspectState(sourceDir);
        const baselineNow = await projects.readMetadata(project, 'upgrade-baseline.json', {});
        const regression = verificationRegressed(baselineNow.verification, verificationSummary(checks), operation.actual_changed_files);
        if (checks.buildResult.status === 'failed') regression.push('Build failed after deterministic rule repair.');
        const runtime = validateRuntime ? await validateRuntime(project) : null;
        if (validateRuntime && (runtime?.status !== 'passed' || runtime?.health !== true)) regression.push('Runtime validation failed after deterministic rule repair.');
        if (!validateRuntime || regression.length) {
          await snapshots.restore(project, dareCheckpoint.id);
          const restoredHash = await sourceFingerprint(sourceDir);
          operation.rollback = { expected_hash: dareBeforeHash, restored_hash: restoredHash, verified: restoredHash === dareBeforeHash };
          await persistRepairOperation(projects, project, operation);
          if (!operation.rollback.verified) throw new Error('Rule DARE rollback verification failed.');
          const reason = !validateRuntime
            ? 'A runtime validator is required before deterministic repair can be completed.'
            : `Deterministic repair did not pass final verification: ${regression.join('; ')}`;
          state.history.push({ cycle, capability: gap.missingCapabilities?.[0] || parsed.name, result: 'rolled_back', error: reason, at: new Date().toISOString() });
          emit('verify', 'failed', reason);
          break;
        }
        transitionRepairOperation(operation, 'VALIDATE', { changed_files: operation.actual_changed_files, runtime: runtime.status });
        await persistRepairOperation(projects, project, operation);
        await inspectUpgrade({ project, projects, snapshots, validateRuntime, jobId });
        emit('verify', 'done', `✓ Builder fixed a proven issue on cycle ${cycle} without AI.`);
        continue;
      }
    }
    const pending = tasks.filter(t => t.status === 'pending').slice(0, execution.maxTasks);
    if (!pending.length) break;
    const task = pending[0];
    const evidenceKey = `${task.capability}|${await sourceFingerprint(sourceDir)}`;
    if (attemptedEvidence.has(evidenceKey)) {
      task.status = 'blocked';
      task.error = 'Same fingerprint and workspace state produced no verified progress; stopping without another AI call.';
      break;
    }
    attemptedEvidence.add(evidenceKey);
    const taskRequest = `${request || parsed.goal}\nRULE TASK: Complete only this task: ${task.capability}\nDo not redesign unrelated parts. Inspect current evidence and preserve working behavior.`;
    emit('plan', 'running', `🧩 Task ${completed + 1}/${tasks.length}: ${task.capability}`);
    transitionRepairOperation(operation, 'DIAGNOSE', { task: task.capability, source_hash: await sourceFingerprint(sourceDir) });
    await persistRepairOperation(projects, project, operation);
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
      task.status = 'blocked'; task.error = String(err.message || err).slice(0, 500);
      await projects.saveMetadata(project, 'upgrade-rule-execution.json', state);
      finishRepairOperation(operation, 'FAILED', { error: redactAiContext(err.message || err), cycle, task: task.capability });
      await persistRepairOperation(projects, project, operation);
      throw err;
    }
    if (plan.needs_user_action) {
      task.status = 'waiting_user'; task.needsUserAction = plan.needs_user_action;
      userAction = plan.needs_user_action;
      emit('input', 'done', `⏸ ${userAction}`);
      if (execution.stopOnUserAction) break;
      continue;
    }
    transitionRepairOperation(operation, 'EVIDENCE', { fingerprint: task.capability, evidence: redactAiContext(JSON.stringify(gap.missingCapabilities || [])) });
    operation.fingerprint = `RULE_TASK:${crypto.createHash('sha256').update(task.capability).digest('hex')}`;
    operation.fingerprint_history.push({ cycle, fingerprint: operation.fingerprint, workspace_hash: await sourceFingerprint(sourceDir) });
    operation.ai_proposal = redactAiContext(JSON.stringify({ root_cause: plan.root_cause, recommendation: plan.recommendation, expected_effect: plan.expected_result, files: (plan.files || []).map((file) => file.path) }));
    operation.proposed_files = (plan.files || []).map((file) => normalize(file.path));
    transitionRepairOperation(operation, 'PLAN', { proposed_files: operation.proposed_files });
    await persistRepairOperation(projects, project, operation);
    if (!Array.isArray(plan.files) || !plan.files.length) {
      task.status = 'blocked';
      task.error = 'AI proposed no source changes for this unmet rule task.';
      await projects.saveMetadata(project, 'upgrade-rule-execution.json', state);
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
      const result = await applyUpgrade({ project, projects, snapshots, plan, request: taskRequest, approved: true, ruleExecution: true, operation, validateRuntime });
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
  const terminalState = userAction ? 'NEEDS_USER_ACTION'
    : state.status === 'completed' ? (completed ? 'DONE' : 'NO_CHANGE')
      : state.history.some((entry) => entry.result === 'failed') ? 'ROLLED_BACK' : 'BLOCKED';
  finishRepairOperation(operation, terminalState, {
    fingerprint: operation.fingerprint || null,
    workspace_hash_after: await sourceFingerprint(sourceDir),
    changed_files: operation.actual_changed_files || [],
    cycle,
    status: state.status,
  });
  state.finishedAt = new Date().toISOString();
  state.gap = gap;
  state.tasks = tasks;
  await projects.saveMetadata(project, 'upgrade-rule-execution.json', state);
  return {
    projectId: project.id,
    rule: parsed,
    execution: state,
    status: state.status,
    terminalState,
    operationId: operation.operation_id,
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

async function inspectState(sourceDir, { installDependencies = true, syntaxFiles = null, precheckedSyntax = null } = {}) {
  const [security, staticResult, nodeResult, syntaxResult, manifest, stack] = await Promise.all([
    scanProject(sourceDir), runStaticTests(sourceDir), runNodeTests(sourceDir, 45000, { installDependencies }),
    precheckedSyntax || runSyntaxChecks(sourceDir, syntaxFiles), fileManifest(sourceDir), discoverStack(sourceDir),
  ]);
  const buildResult = nodeResult.build === 'passed'
    ? { status: 'passed', script: 'npm run build' }
    : await runProjectBuild(sourceDir);
  const issues = classifyIssues({ stack, security, staticResult, nodeResult, syntaxResult, buildResult });
  return {
    security, staticResult, nodeResult, syntaxResult, buildResult, manifest, stack, issues,
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

function classifyIssues({ stack, security, staticResult, nodeResult, syntaxResult, buildResult }) {
  const out = [];
  for (const f of security.findings || []) out.push({ id: f.id, category: 'SECURITY', severity: f.severity, evidence: `${f.file}${f.line ? `:${f.line}` : ''}`, autoFix: Boolean(f.autoFix) });
  if (syntaxResult?.status === 'failed') {
    for (const check of syntaxResult.checks.filter((item) => !item.ok)) {
      out.push({
        id: `syntax:${check.file}`, category: 'BUG', severity: 'high',
        evidence: `${check.file}: ${String(check.error || 'JavaScript syntax error').split(/\r?\n/).slice(0, 3).join(' ').slice(0, 300)}`,
        autoFix: true,
      });
    }
  }
  if (staticResult.status === 'failed') out.push({ id: 'static-tests', category: 'BUG', severity: 'high', evidence: staticResult.summary || 'Static checks failed', autoFix: false });
  if (nodeResult.status === 'failed') out.push({ id: 'node-tests', category: 'RUNTIME', severity: 'high', evidence: nodeResult.summary || 'Node tests failed', autoFix: false });
  if (buildResult?.status === 'failed') out.push({ id: 'project-build', category: 'BUILD', severity: 'high', evidence: String(buildResult.error || 'Project build failed').slice(0, 300), autoFix: false });
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
  const selected = files.map((file) => ({
    file,
    score: keywords.reduce((sum, word) => sum + (file.toLowerCase().includes(word) ? 5 : 0), 0)
      + (/package\.json|Dockerfile|compose|config|route|api|server|app|index|readme/i.test(file) ? 2 : 0),
  })).sort((a, b) => b.score - a.score || a.file.localeCompare(b.file)).slice(0, 16);
  const parts = [`SOURCE INVENTORY (${files.length} files): ${files.slice(0, 80).join(', ')}`];
  let total = parts[0].length;
  for (const { file: rel } of selected) {
    if (total >= 18000) break;
    const text = await fs.readFile(path.join(sourceDir, rel), 'utf8').catch(() => '');
    if (!text) continue;
    const chunk = `FILE ${rel}\n${text.slice(0, Math.min(2400, 18000 - total))}`;
    parts.push(chunk);
    total += chunk.length;
  }
  return parts.join('\n\n');
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

function dependencyManifestChanged(before, after) {
  return diffManifest(before, after).some((file) => /(^|\/)(?:package\.json|package-lock\.json|npm-shrinkwrap\.json)$/.test(file));
}

function manifestHash(manifest) { return crypto.createHash('sha256').update(JSON.stringify(manifest || [])).digest('hex'); }
function normalize(p) { return String(p || '').replace(/\\/g, '/').replace(/^\.\//, ''); }
function score(staticResult, nodeResult, security) { return (staticResult?.status === 'failed' ? 2 : 0) + (nodeResult?.status === 'failed' ? 2 : 0) + Number(security?.critical || 0) * 4 + Number(security?.warning || 0); }
function summarizeSecurity(s) { return { status: s.status, critical: s.critical, warning: s.warning, findings: (s.findings || []).map((f) => ({ id: f.id, severity: f.severity, file: f.file, title: f.title })) }; }

function verificationSummary(state) {
  const staticChecks = state.staticResult?.checks || [];
  const syntaxChecks = state.syntaxResult?.checks || [];
  const nodeError = String(state.nodeResult?.error || '');
  const nodeFailures = nodeError.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /(?:not ok\s+\d|✖|FAIL\b|SyntaxError:)/i.test(line))
    .map((line) => line.replace(/\s+\(\d+(?:\.\d+)?ms\).*$/, '').slice(0, 240))
    .slice(0, 30);
  return {
    static: {
      status: state.staticResult?.status || 'unknown',
      failedChecks: staticChecks.filter((check) => !check.ok).map((check) => check.name),
    },
    node: {
      status: state.nodeResult?.status || 'unknown',
      stage: state.nodeResult?.stage || null,
      failures: nodeFailures.length ? nodeFailures : state.nodeResult?.status === 'failed' ? ['node-tests-failed'] : [],
    },
    syntax: {
      status: state.syntaxResult?.status || 'unknown',
      checked: state.syntaxResult?.checked || 0,
      failedFiles: syntaxChecks.filter((check) => !check.ok).map((check) => check.file),
    },
    build: {
      status: state.buildResult?.status || 'unknown',
      error: state.buildResult?.status === 'failed' ? String(state.buildResult.error || '').slice(0, 1000) : null,
    },
    security: {
      findings: (state.security?.findings || [])
        .filter((finding) => finding.severity === 'critical' || finding.severity === 'warning')
        .map((finding) => `${finding.severity}|${finding.id}|${finding.file}`),
    },
  };
}

function mergeChangedSyntax(baseline, changed, changedFiles) {
  const changedSet = new Set(changedFiles.map(normalize));
  const unchangedFailures = (baseline?.failedFiles || [])
    .filter((file) => !changedSet.has(normalize(file)))
    .map((file) => ({ file, ok: false, error: 'Pre-existing syntax failure in an unchanged file.' }));
  const checks = [...unchangedFailures, ...(changed?.checks || [])];
  const failed = checks.filter((check) => !check.ok);
  return {
    status: failed.length
      ? 'failed'
      : baseline?.status === 'skipped' && changed?.status === 'skipped' ? 'skipped' : 'passed',
    checked: Number(baseline?.checked || 0) + Number(changed?.checked || 0),
    failed: failed.length,
    checks,
  };
}

function verificationRegressed(before, after, changedFiles = []) {
  const failures = [];
  const previousStatic = new Set(before?.static?.failedChecks || []);
  for (const name of after?.static?.failedChecks || []) {
    if (!previousStatic.has(name)) failures.push(`New static failure: ${name}`);
  }
  if (before?.node?.status !== 'failed' && after?.node?.status === 'failed') {
    failures.push('Node tests failed after the change.');
  } else if (before?.node?.status === 'failed' && after?.node?.status === 'failed') {
    const previous = new Set(before.node.failures || []);
    for (const name of after.node.failures || []) {
      if (!previous.has(name) && name !== 'node-tests-failed') failures.push(`New Node test failure: ${name}`);
    }
  }
  if (before?.build?.status !== 'failed' && after?.build?.status === 'failed') failures.push('Project build failed after the change.');
  const previousSyntax = new Set(before?.syntax?.failedFiles || []);
  for (const file of after?.syntax?.failedFiles || []) {
    if (!previousSyntax.has(file) || changedFiles.some((changed) => normalize(changed) === normalize(file))) {
      failures.push(`JavaScript syntax check failed: ${file}`);
    }
  }
  const previousSecurity = new Set(before?.security?.findings || []);
  for (const finding of after?.security?.findings || []) {
    if (!previousSecurity.has(finding)) failures.push(`New security finding: ${finding}`);
  }
  return failures;
}

function verificationError(message, evidence) {
  const err = new Error(message);
  err.code = 'UPGRADE_VERIFICATION_FAILED';
  err.upgradeVerification = evidence;
  return err;
}

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
