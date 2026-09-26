import path from 'node:path';
import { SYSTEM, ideaPrompt, planPrompt, codePrompt, patchPrompt, reviewPrompt, chatPrompt, builderChatPrompt, descriptionPrompt } from '../ai/prompts.js';
import { localAnalysis, localPlan, writeGeneratedFiles, scaffoldFromTemplate, writeGithubWorkflow } from '../projects/generator.js';
import { importZipBuffer } from '../projects/importer.js';
import { runStaticTests, runNodeTests } from '../testing/engine.js';
import { scanProject } from '../security/scanner.js';
import { clampText } from '../utils/validate.js';
import { listFiles } from '../utils/fsx.js';
import fs from 'node:fs/promises';
import dns from 'node:dns/promises';
import https from 'node:https';
import { saveAttachment, attachmentContext, attachmentList, imageInputsFromAttachments } from '../projects/attachments.js';
import { writeSoloHostPackage } from '../release/solohost.js';
import { inferAction, extractGhcrImage, guessSoloHostPorts, classifyLogs, classifyFailureLayer, formatLayerDiagnosis, describeFailure, diagnoseSource, nextStep, guideCard, isHostDockerCommand, isNpmOnEmptyRisk, splitUserSteps, parseGithubRepoUrl } from '../scripts/ops.js';
import { stampMadeBy } from '../projects/badge.js';
import { createProjectZip } from '../projects/exporter.js';
import { gcDocker } from '../docker/cleanup.js';
import { detectUserLanguage, languageInstruction, languageInstructionFor } from '../ai/language.js';
import { publishToGitHub } from '../github/publish.js';
import { ensureMissingDependencies } from '../projects/deps-fix.js';
import { runDare, formatDareReport } from '../dare/engine.js';
import { shouldBlockRepeatedAction, nextRepeatState, repairFingerprint } from './loop-guard.js';
import { mergeVerificationState } from './verification.js';
import { maskSecrets } from '../utils/mask.js';
import { inspectUpgrade, diagnoseUpgradeRequest, applyUpgrade } from '../upgrade/engine.js';
import { diagnoseProject, buildAdvisorReport } from '../diagnose/project.js';
import { refreshProjectBrain, rememberFailedRepair, wasRepairTried } from '../diagnose/brain.js';

// Safety net only — does not change what inspectUpgrade does on the happy path.
// Without this, a slow/unusual imported repo (e.g. a hung install/test step)
// could leave the Upgrade job stuck in "running" forever: the busy bar never
// clears and no message is ever shown, which looks exactly like a broken
// button. This guarantees the job always settles within a bounded time.
const UPGRADE_INSPECT_TIMEOUT_MS = 5 * 60 * 1000;
function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function registerPipeline(app) {
  const { jobs, ai, projects, snapshots, runner, sandbox, github, releases, cfg, log } = app;

  // Upgrade Workshop is deliberately isolated from create_app/improve flows.
  jobs.on('project_diagnose', async (job, { emit }) => {
    const project = mustProject(job.payload.projectId);
    emit('inspect', 'running', '🩺 Inspecting the project before making any change…');
    const runtime = await projects.readMetadata(project, 'runtime-state.json', {});
    const recent = await projects.readMetadata(project, 'runtime-diagnostics.json', {});
    const logs = [recent?.error, recent?.logs, runtime?.error, runtime?.logs].filter(Boolean).join('\n');
    const report = await diagnoseProject({ project: projects.get(project.id), projects, db: app.db, ai, logs });
    await refreshProjectBrain({ project, projects, db: app.db, extra: { notes: report.rootCause } });
    emit('diagnose', 'done', `Diagnosis complete: ${report.confidence} confidence. No files were changed.`);
    return { projectId: project.id, diagnosis: report, status: 'DIAGNOSED', brief: formatProjectDiagnosis(report) };
  });

  jobs.on('builder_advisor', async (job, { emit }) => {
    const project = job.payload.projectId ? projects.get(job.payload.projectId) : (projects.list()[0] || null);
    emit('advisor', 'running', '🧭 Reviewing session history. No files will be changed.');
    const report = await buildAdvisorReport({ project, projects, db: app.db, scope: job.payload.scope || '30d' });
    if (project) await refreshProjectBrain({ project, projects, db: app.db });
    emit('advisor', 'done', formatAdvisor(report));
    return { projectId: project?.id || null, advisor: report, status: 'ADVISOR_READY', brief: formatAdvisor(report) };
  });

  jobs.on('upgrade_github_import', async (job, { emit }) => {
    const parsed = parseGithubRepoUrl(job.payload.url);
    if (!parsed) throw new Error('Use a public GitHub repository URL such as https://github.com/owner/repository');
    const owner = parsed.owner;
    const repo = parsed.repo;
    const url = parsed.url;
    const archiveUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/zipball/HEAD`;
    emit('import', 'running', `Fetching public GitHub source: ${owner}/${repo}…`);
    const response = await fetch(archiveUrl, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'pi-app-factory-upgrade' } });
    if (!response.ok) throw new Error(`GitHub public repository could not be downloaded (HTTP ${response.status}).`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const project = await projects.create({ idea: `Upgrade existing GitHub app: ${owner}/${repo}`, name: repo, analysis: { name: repo, slug: repo, recommended_stack: {} }, plan: { mode: 'upgrade-existing' } });
    jobs.attachProject(job.id, project.id);
    await importZipBuffer(buffer, projects.sourceDir(project.slug), { replace: true });
    await projects.saveMetadata(project, 'upgrade-source.json', { type: 'github-public', url, owner, repo, importedAt: new Date().toISOString() });
    projects.setStatus(project, 'UPGRADE_INSPECTING');
    emit('import', 'done', 'GitHub source imported. Starting the independent Upgrade Workshop.');
    emit('inspect', 'running', 'Inspecting the imported app and creating an upgrade baseline…');
    let result;
    try {
      result = await withTimeout(
        inspectUpgrade({ project: projects.get(project.id), projects, snapshots, log }),
        UPGRADE_INSPECT_TIMEOUT_MS,
        'Upgrade inspection took too long and was stopped. This can happen with large or unusual repositories — try again, or use Import ZIP with just the app source instead.',
      );
    } catch (err) {
      projects.setStatus(projects.get(project.id), 'UPGRADE_READY');
      emit('inspect', 'failed', String(err.message || err).slice(0, 280));
      return {
        projectId: project.id,
        ready: true,
        source: { type: 'github-public', owner, repo, url },
        issues: [{ id: 'inspect-partial', detail: String(err.message || err) }],
        safeRepairs: [],
        brief: `Project ${repo} is open in the Upgrade Workshop. Inspection was incomplete: ${String(err.message || err).slice(0, 180)}\nTell me what you want to improve.`,
      };
    }
    projects.setStatus(projects.get(project.id), result.ready ? 'UPGRADE_READY' : 'FAILED');
    return { projectId: project.id, source: { type: 'github-public', owner, repo, url }, ...result };
  });

  jobs.on('upgrade_inspect', async (job, { emit }) => {
    const project = mustProject(job.payload.projectId);
    projects.setStatus(project, 'UPGRADE_INSPECTING');
    emit('inspect', 'running', 'Inspecting the existing app before any upgrade request…');
    const result = await withTimeout(
      inspectUpgrade({ project: projects.get(project.id), projects, snapshots, log }),
      UPGRADE_INSPECT_TIMEOUT_MS,
      'Upgrade inspection took too long and was stopped. This can happen with large or unusual repositories — try again, or use Import ZIP with just the app source instead.',
    );
    projects.setStatus(projects.get(project.id), result.ready ? 'UPGRADE_READY' : 'FAILED');
    emit('baseline', 'done', `Baseline ready. ${result.safeRepairs.length} safe repair(s) applied; ${result.issues.length} finding(s) recorded.`);
    return result;
  });

  jobs.on('upgrade_request', async (job, { emit }) => {
    const project = mustProject(job.payload.projectId);
    const baseline = await projects.readMetadata(project, 'upgrade-baseline.json', null);
    if (!baseline) throw new Error('Upgrade baseline is missing. Inspect the app first.');
    projects.setStatus(project, 'UPGRADE_DIAGNOSING');
    emit('diagnose', 'running', 'Diagnosing the request against the real app baseline…');
    const plan = await diagnoseUpgradeRequest({ project, projects, ai, request: job.payload.request });
    await projects.saveMetadata(project, 'upgrade-plan.json', { ...plan, request: job.payload.request, createdAt: new Date().toISOString() });
    projects.setStatus(projects.get(project.id), 'UPGRADE_WAITING_APPROVAL');
    emit('recommend', 'done', plan.recommendation || 'Upgrade plan is ready for review.');
    return { projectId: project.id, plan: { ...plan, request: job.payload.request }, needsApproval: true };
  });

  jobs.on('upgrade_apply', async (job, { emit }) => {
    const project = mustProject(job.payload.projectId);
    projects.setStatus(project, 'UPGRADING');
    emit('patch', 'running', 'Applying only the approved upgrade files…');
    const plan = job.payload.plan || await projects.readMetadata(project, 'upgrade-plan.json', {});
    const result = await applyUpgrade({ project: projects.get(project.id), projects, snapshots, plan, request: job.payload.request || plan.request || '', approved: job.payload.approved === true });
    projects.setStatus(projects.get(project.id), 'UPGRADE_READY');
    emit('verify', 'done', `Upgrade verified. ${result.files.length} file(s) changed. Ready for release or rollback.`);
    return result;
  });

  jobs.on('create_app', async (job, { emit }) => {
    const idea = String(job.payload.idea || '').trim();
    if (!idea) throw new Error('Describe your idea first.');
    const userLanguage = detectUserLanguage(idea);

    emit('analyze', 'running', 'Understanding your idea…');
    let analysis;
    const incomingFiles = Array.isArray(job._files) ? job._files : [];
    try {
      const attachmentSummary = incomingFiles.map((f) => ({ name: f.originalname, type: f.mimetype, bytes: f.buffer?.length || 0 }));
      const r = await ai.completeJson({ task: 'IDEA_ANALYSIS', system: SYSTEM, prompt: ideaPrompt(idea, attachmentSummary), images: imageInputs(incomingFiles) });
      analysis = r.json;
    } catch (err) {
      log.warn('Idea analysis fell back to local defaults', { error: err.message });
      analysis = localAnalysis(idea);
      analysis.fallbackReason = friendlyAiError(err);
    }

    emit('plan', 'running', 'Preparing a simple plan…');
    let plan;
    try {
      const attachmentSummary = incomingFiles.map((f) => ({ name: f.originalname, type: f.mimetype, bytes: f.buffer?.length || 0 }));
      const r = await ai.completeJson({ task: 'PRODUCT_PLANNING', system: SYSTEM, prompt: planPrompt(idea, analysis, JSON.stringify(attachmentSummary)), images: imageInputs(incomingFiles) });
      plan = r.json;
    } catch (err) {
      plan = localPlan(idea, analysis);
      plan.fallbackReason = friendlyAiError(err);
    }

    const project = await projects.create({
      idea,
      name: plan.name || analysis.name,
      analysis,
      plan,
    });
    for (const file of incomingFiles.slice(0, 8)) {
      if (file?.buffer) await saveAttachment(projects.projectDir(project), file);
    }
    await projects.chat(project, idea, 'user', { attachments: incomingFiles.map((f) => f.originalname).filter(Boolean) });
    analysis.questions = normalizeQuestions(analysis.questions);
    await projects.saveMetadata(project, 'requirements.json', analysis);
    await projects.saveMetadata(project, 'architecture.json', plan);
    await projects.saveMetadata(project, 'user-language.json', { language: userLanguage, source: idea });
    jobs.attachProject(job.id, project.id);
    const initialPlan = await projects.startWorkPlan(project, {
      jobId: job.id,
      message: idea,
      action: 'create_app',
      language: userLanguage,
      steps: [
        { action: 'analyze', goal: 'Understand the idea, constraints, and required features.' },
        { action: 'plan', goal: 'Choose the smallest safe architecture and verification plan.' },
        { action: 'build', goal: 'Generate the first complete application without secrets.' },
        { action: 'test', goal: 'Run static checks, security scan, preview, and browser verification.' },
      ],
    });
    await projects.updateWorkPlan(project, { stepId: initialPlan.steps[0].id, step: { status: 'done', result: 'Requirements analyzed.' } });
    await projects.updateWorkPlan(project, { stepId: initialPlan.steps[1].id, step: { status: 'done', result: 'Architecture and product plan saved.' } });
    emit('plan', 'done', 'Job plan saved. Every build step will report what changed and what remains.');

    if (job.payload.autoBuild && analysis.questions.length && !job.payload.demo) {
      projects.setStatus(project, 'WAITING_INPUT');
      await projects.chat(project, 'I need a few quick choices before I build this.', 'assistant', { questions: analysis.questions, fixedTemplate: true });
      await projects.finishWorkPlan(project, 'waiting_input', 'Waiting for the user choices before build can continue.');
      emit('questions', 'done', 'I need a few quick choices before I build this.');
      return { projectId: project.id, analysis, plan, needsInput: true, questions: analysis.questions };
    }

    projects.setStatus(project, 'READY_TO_BUILD');
    if (job.payload.autoBuild) {
      await projects.updateWorkPlan(project, { stepId: initialPlan.steps[2].id, step: { status: 'running' } });
      emit('generate', 'running', 'Writing the first version…');
      try {
        await generateCode({ project: projects.get(project.id), analysis, plan, emit, allowFallback: Boolean(job.payload.demo) });
        await projects.updateWorkPlan(project, { stepId: initialPlan.steps[2].id, step: { status: 'done', result: 'Application files generated.' } });
        await projects.updateWorkPlan(project, { stepId: initialPlan.steps[3].id, step: { status: 'done', result: 'Initial checks and preview completed.' } });
        await projects.finishWorkPlan(project, 'done', 'Initial app build and verification are recorded. Future changes must use a new plan step.');
      } catch (err) {
        await projects.updateWorkPlan(project, { stepId: initialPlan.steps[2].id, step: { status: 'failed', error: String(err.message || err).slice(0, 1000) } });
        await projects.finishWorkPlan(project, 'failed', 'Initial build stopped safely. No unverified build is reported as complete.');
        throw err;
      }
    } else {
      await projects.finishWorkPlan(project, 'waiting_input', 'Plan is ready. Start Build when you want the app files generated.');
    }

    return { projectId: project.id, analysis, plan };
  });

  jobs.on('continue_build', async (job, { emit }) => {
    const project = mustProject(job.payload.projectId);
    const analysis = await projects.readMetadata(project, 'requirements.json', {});
    const plan = await projects.readMetadata(project, 'architecture.json', {});
    const answers = job.payload.answers || {};
    analysis.answers = answers;
    analysis.questions = normalizeQuestions(analysis.questions);
    await projects.saveMetadata(project, 'requirements.json', analysis);
    emit('plan', 'running', 'Updating the plan from your choices…');
    let nextPlan = plan;
    try {
      const r = await ai.completeJson({ task: 'PRODUCT_PLANNING', system: SYSTEM, prompt: planPrompt(`${project.idea}\nUser choices: ${JSON.stringify(answers)}`, analysis), projectId: project.id });
      nextPlan = r.json;
    } catch (err) {
      log.warn('Plan refresh fell back to saved plan', { error: err.message });
    }
    await projects.saveMetadata(project, 'architecture.json', nextPlan);
    projects.setStatus(project, 'READY_TO_BUILD');
    const workPlan = await projects.startWorkPlan(project, {
      jobId: job.id,
      message: `Continue build with choices: ${JSON.stringify(answers)}`,
      action: 'continue_build',
      language: detectUserLanguage(project.idea),
      steps: [{ action: 'build', goal: 'Generate the app using the saved choices.' }, { action: 'test', goal: 'Verify the generated app and preview.' }],
    });
    await projects.updateWorkPlan(project, { stepId: workPlan.steps[0].id, step: { status: 'running' } });
    try {
      const result = await generateCode({ project: projects.get(project.id), analysis, plan: nextPlan, emit, allowFallback: false });
      await projects.updateWorkPlan(project, { stepId: workPlan.steps[0].id, step: { status: 'done', result: 'Application files generated.' } });
      await projects.updateWorkPlan(project, { stepId: workPlan.steps[1].id, step: { status: 'done', result: 'Initial checks and preview completed.' } });
      const finished = await projects.finishWorkPlan(project, 'done', 'Build resumed from the saved plan and was verified.');
      return { ...result, workPlan: finished };
    } catch (err) {
      await projects.updateWorkPlan(project, { stepId: workPlan.steps[0].id, step: { status: 'failed', error: String(err.message || err).slice(0, 1000) } });
      await projects.finishWorkPlan(project, 'failed', 'Build stopped safely; no unverified result is reported as complete.');
      throw err;
    }
  });

  jobs.on('build', async (job, { emit }) => {
    const project = mustProject(job.payload.projectId);
    const analysis = await projects.readMetadata(project, 'requirements.json', {});
    const plan = await projects.readMetadata(project, 'architecture.json', {});
    const workPlan = await projects.startWorkPlan(project, {
      jobId: job.id,
      message: 'Build the saved project plan.',
      action: 'build',
      language: detectUserLanguage(project.idea),
      steps: [{ action: 'build', goal: 'Generate or update the application files from the saved plan.' }, { action: 'test', goal: 'Verify the build, security, preview, and browser flow.' }],
    });
    await projects.updateWorkPlan(project, { stepId: workPlan.steps[0].id, step: { status: 'running' } });
    try {
      const result = await generateCode({ project, analysis, plan, emit, allowFallback: false });
      await projects.updateWorkPlan(project, { stepId: workPlan.steps[0].id, step: { status: 'done', result: 'Application files generated.' } });
      await projects.updateWorkPlan(project, { stepId: workPlan.steps[1].id, step: { status: 'done', result: 'Checks and preview completed.' } });
      const finished = await projects.finishWorkPlan(project, 'done', 'Build and verification were recorded.');
      return { ...result, workPlan: finished };
    } catch (err) {
      await projects.updateWorkPlan(project, { stepId: workPlan.steps[0].id, step: { status: 'failed', error: String(err.message || err).slice(0, 1000) } });
      await projects.finishWorkPlan(project, 'failed', 'Build stopped safely; no unverified result is reported as complete.');
      throw err;
    }
  });

  jobs.on('test', async (job, { emit }) => {
    const project = mustProject(job.payload.projectId);
    return testAndMaybeFix(project, emit);
  });

  jobs.on('analyze', async (job, { emit }) => {
    const project = mustProject(job.payload.projectId);
    emit('analyze', 'running', 'Checking files, tests, Docker build, and security…');
    const source = projects.sourceDir(project.slug);
    const diagnosis = await diagnoseSource(source);
    if (!diagnosis.files.length) {
      return {
        action: 'analyze',
        ok: false,
        diagnosis,
        brief: 'Check is locked. There is no app yet. Tap Build first.',
        next: 'Tap ✨ Build, then Check again.',
      };
    }
    const tested = await testAndMaybeFix(project, emit);
    const runtime = await projects.readMetadata(project, 'runtime.json', {});
    const brief = [
      tested.scan?.critical ? 'Security issues were found.' : 'Security scan is clean.',
      tested.staticResult?.status === 'passed' ? 'Required files look complete.' : 'Some required files are missing.',
      tested.dockerBuild?.status === 'passed' ? 'Docker build passed.' : `Docker build: ${tested.dockerBuild?.error || tested.dockerBuild?.reason || tested.dockerBuild?.status || 'not run'}.`,
      runtime.status === 'passed' ? 'A preview has already run.' : 'Tap ▶ Run to open a live preview.',
    ].join(' ');
    return {
      action: 'analyze',
      ok: tested.scan?.critical === 0 && tested.staticResult?.status === 'passed',
      tested,
      diagnosis,
      brief,
      next: tested.scan?.critical ? 'Tap Improve so I can remove the unsafe setting.' : (runtime.status === 'passed' ? 'If the preview looks right, tap Publish.' : 'Tap ▶ Run next.'),
    };
  });

  jobs.on('security', async (job, { emit }) => {
    const project = mustProject(job.payload.projectId);
    emit('security', 'running', 'Checking for secrets and unsafe settings…');
    projects.setStatus(project, 'SECURITY_CHECK');
    const scan = await scanProject(projects.sourceDir(project.slug));
    await projects.saveMetadata(project, 'security.json', scan);
    if (scan.status === 'BLOCK') projects.setStatus(project, 'FAILED');
    else projects.setStatus(project, 'WAITING_APPROVAL');
    return scan;
  });

  jobs.on('run', async (job, { emit }) => {
    const project = mustProject(job.payload.projectId);
    emit('run', 'running', 'Starting a safe local preview…');
    projects.setStatus(project, 'BUILDING');
    const sourcePath = projects.sourceDir(project.slug);
    const result = await runner.runApp({ sourcePath, projectSlug: project.slug, timeout: cfg.limits.sandboxTimeoutSec, keepRunning: true });
    const publicBase = String(process.env.PREVIEW_PUBLIC_BASE_URL || '').replace(/\/$/, '');
    const publicUiUrl = publicBase ? `${publicBase}/preview/${encodeURIComponent(project.slug)}/` : `/preview/${encodeURIComponent(project.slug)}/`;
    const runtime = { ...result, image: null, imageFile: null, publicUiUrl, lastSeenAt: new Date().toISOString(), nextSteps: result.status === 'passed' ? ['Open the preview', 'Improve with AI if needed', 'Publish when ready'] : ['Fix the reported issue', 'Run again'], updatedAt: new Date().toISOString() };
    await projects.saveMetadata(project, 'runtime.json', runtime);
    const tests = await projects.readMetadata(project, 'test-plan.json', {});
    const previewPassed = result.status === 'passed' && result.health === true;
    const refreshedTests = {
      ...tests,
      preview: result,
      e2e: result.e2e || null,
      verifiedAt: new Date().toISOString(),
    };
    if (previewPassed) {
      // Live preview + health is the source of truth for SoloHost readiness.
      // Stale npm-test failures (wrong PORT, fork timing) must not block Publish.
      refreshedTests.nodeResult = {
        status: 'passed',
        runner: 'preview-health',
        superseded: tests.nodeResult?.status === 'failed' ? tests.nodeResult : null,
        reason: 'Preview health and browser checks passed; those replace the earlier local npm test report.',
      };
    }
    await projects.saveMetadata(project, 'test-plan.json', refreshedTests);
    if (result.status === 'passed') {
      projects.setStatus(project, 'WAITING_APPROVAL');
      emit('run', 'done', runtime.internet?.ok === true ? '✓ Preview started; health, browser, and Internet checks passed.' : '✓ Preview started and browser check passed. Internet browsing is not yet verified.');
    } else {
      projects.setStatus(project, 'FAILED');
      const message = result.error || 'The app could not start or pass browser testing.';
      emit('run', 'failed', message);
      // Fix: previously this handler returned normally even when the preview failed,
      // which made JobQueue mark the job "done" and hid the error + link from the UI.
      // Throwing here makes JobQueue mark it "failed" so the real error reaches the user.
      emit('diagnose', 'running', '⚠️ Problem detected. Investigating…');
      try {
        const report = await diagnoseProject({ project, projects, db: app.db, logs: [result.error, result.logs, message].filter(Boolean).join('\n') });
        await refreshProjectBrain({ project, projects, db: app.db, extra: { notes: report.rootCause } });
        const brief = formatUserDiagnosis(report);
        emit('diagnose', 'done', brief);
        const err = new Error(brief);
        err.diagnosis = report;
        throw err;
      } catch (diagErr) {
        if (diagErr.diagnosis) throw diagErr;
        throw new Error(message);
      }
    }
    return { ...runtime, downloads: [], ui_url: publicUiUrl, next: 'Open the test link, improve if needed, then Publish.' };
  });

  jobs.on('stop', async (job, { emit }) => {
    const project = mustProject(job.payload.projectId);
    emit('stop', 'running', 'Stopping the preview…');
    const result = await runner.stopApp({ projectSlug: project.slug });
    await projects.saveMetadata(project, 'runtime.json', { status: 'stopped', stoppedAt: new Date().toISOString(), ...result });
    if (project.status !== 'RELEASED') projects.setStatus(project, 'WAITING_APPROVAL');
    return result;
  });

  jobs.on('improve', async (job, { emit }) => {
    const project = mustProject(job.payload.projectId);
    const feedback = String(job.payload.feedback || '').trim();
    if (!feedback) throw new Error('Tell AI what to improve.');
    const incomingFiles = Array.isArray(job._files) ? job._files : [];
    for (const file of incomingFiles.slice(0, 8)) {
      if (file?.buffer) await saveAttachment(projects.projectDir(project), file);
    }
    if (incomingFiles.length) {
      await projects.chat(project, `📎 Attached ${incomingFiles.length} file(s) for this repair.`, 'system', {
        attachments: incomingFiles.map((file) => file.originalname).filter(Boolean),
      });
    }
    const language = detectUserLanguage(feedback);
    const plan = await projects.startWorkPlan(project, {
      jobId: job.id,
      message: feedback,
      action: 'improve',
      language,
      steps: [{ action: 'improve', goal: feedback, tests: ['static checks', 'runtime tests', 'security scan', 'preview'] }],
    });
    emit('plan', 'done', 'Plan created: inspect → patch only affected files → verify → keep or roll back.');
    await projects.updateWorkPlan(project, { stepId: plan.steps[0].id, step: { status: 'running' } });
    emit('ai', 'running', 'AI is turning your feedback into a change…');
    try {
      const result = await improveProject(project, feedback, emit);
      if (result.tested) {
        const previousTests = await projects.readMetadata(project, 'test-plan.json', {});
        await projects.saveMetadata(project, 'test-plan.json', mergeVerificationState(previousTests, result.tested));
      }
      if (result.runtime?.status === 'passed' || (result.tested?.staticResult?.status === 'passed' && result.tested?.nodeResult?.status !== 'failed' && result.tested?.scan?.critical === 0)) {
        await projects.saveMetadata(project, 'action-guard.json', null);
      }
      await projects.updateWorkPlan(project, {
        stepId: plan.steps[0].id,
        step: { status: 'done', files: result.files || [], result: result.explanation || 'Change verified.' },
        reports: [{ action: 'improve', status: 'done', files: result.files || [], explanation: result.explanation || '' }],
      });
      const finished = await projects.finishWorkPlan(project, 'done', 'Change was checked after the patch. The checkpoint remains available for rollback.');
      return { ...result, workPlan: finished };
    } catch (err) {
      await projects.updateWorkPlan(project, {
        stepId: plan.steps[0].id,
        step: { status: 'failed', error: String(err.message || err).slice(0, 1000), notes: ['No unverified change is reported as complete.'] },
        reports: [{ action: 'improve', status: 'failed', error: String(err.message || err).slice(0, 1000) }],
      });
      await projects.finishWorkPlan(project, 'failed', 'The step stopped safely. Review the error and the saved checkpoint before continuing.');
      throw err;
    }
  });

  jobs.on('sandbox', async (job, { emit }) => {
    const project = mustProject(job.payload.projectId);
    emit('sandbox', 'running', 'Trying the app in a temporary box…');
    projects.setStatus(project, 'SANDBOX');
    const result = await sandbox.run({
      project,
      sourcePath: projects.sourceDir(project.slug),
      jobId: job.id,
    });
    if (result.status === 'passed') projects.setStatus(project, 'WAITING_APPROVAL');
    return result;
  });

  jobs.on('github', async (job, { emit }) => {
    const project = mustProject(job.payload.projectId);
    emit('github', 'running', 'Publishing to GitHub…');
    const pushed = await publishToGitHub({
      github,
      project,
      sourceDir: projects.sourceDir(project.slug),
      version: project.version,
      emit,
    });
    await projects.saveMetadata(project, 'release.json', { github: pushed });
    if (!pushed.ok) throw new Error([pushed.error, pushed.fix].filter(Boolean).join('\n\n'));
    return pushed;
  });

  async function runRelease(project, payload, emit) {
    emit('validate', 'running', '✓ App generated — validating project files…');
    const tests = await projects.readMetadata(project, 'test-plan.json', {});
    const source = projects.sourceDir(project.slug);
    const security = await scanProject(source);
    await projects.saveMetadata(project, 'security.json', security);
    const runtime = await projects.readMetadata(project, 'runtime.json', {});
    if (payload.approved !== true && payload.confirm !== true) throw new Error('Release blocked: approve the tested app first.');
    if (security.critical > 0) {
      const report = security.copy_for_ai || 'APP BUILDER SECURITY REPORT\nNo detailed report was generated.';
      emit('security', 'failed', `${security.summary}\n\n${report}`);
      throw new Error(`RELEASE_SECURITY_BLOCKED\n${security.summary}\n\n${report}\n\nNEXT: Tap Improve and let the AI apply the smallest targeted security fix, then Run and Publish again.`);
    }
    if (runtime.status !== 'passed' || runtime.health !== true) throw new Error('Release blocked: run the app successfully before publishing. Tap Run first.');

    const pendingEarly = await projects.readMetadata(project, 'release-pending.json', null);
    const verifyOnlyEarly = Boolean(pendingEarly?.githubUrl)
      && payload.existingAction !== 'overwrite'
      && payload.forcePublish !== true
      && (
        payload.verifyImage === true
        || payload.recheck === true
        || pendingEarly.status === 'workflow_failed'
        || pendingEarly.status === 'waiting_image'
      );

    // SoloHost runtime contract preflight runs before the first GitHub publication.
    // Check-image / re-check must not re-apply the same Dockerfile contract or the
    // user gets a repair loop while GitHub Actions is still building.
    let releaseDare = { ok: false, stopped: false, alreadyFixed: false };
    if (!verifyOnlyEarly) {
      const releaseDareHistory = await projects.readMetadata(project, 'dare-history.json', []);
      const releaseDareCheckpoint = await snapshots.create(project, 'before-release-runtime-preflight').catch(() => null);
      releaseDare = await runDare({
        sourceDir: source,
        logs: `${runtime.error || ''}\n${runtime.logs || ''}`,
        extra: { message: 'SOLOHOST_RELEASE_PREFLIGHT' },
        history: Array.isArray(releaseDareHistory) ? releaseDareHistory : [],
      });
      await projects.saveMetadata(project, 'dare-history.json', (releaseDare.history || []).slice(-20));
      if (releaseDare.ok && (releaseDare.changed || []).length) {
        emit('validate', 'running', `SoloHost runtime preflight repaired ${releaseDare.files.join(', ') || 'the runtime contract'}; rechecking before publish…`);
        const preflightStatic = await runStaticTests(source);
        const preflightNode = await runNodeTests(source, 45000);
        const preflightScan = await scanProject(source);
        if (preflightStatic.status === 'failed' || preflightNode.status === 'failed' || preflightScan.critical > 0) {
          if (releaseDareCheckpoint?.id) await snapshots.restore(project, releaseDareCheckpoint.id).catch(() => {});
          throw new Error(`RELEASE_RUNTIME_PREFLIGHT_FAILED\n${formatDareReport(releaseDare)}\nThe deterministic repair did not pass local verification, so the previous state was restored.`);
        }
        emit('validate', 'done', `✓ SoloHost runtime preflight passed after ${releaseDare.ruleId || 'deterministic'} repair.`);
      } else if (releaseDare.alreadyFixed || releaseDare.next === 'CONTINUE') {
        emit('validate', 'done', '✓ SoloHost runtime contract already satisfied. Continuing publish.');
      } else if (releaseDare.stopped && pendingEarly?.githubUrl) {
        emit('validate', 'done', 'Runtime contract was already repaired. Checking GitHub/GHCR instead of repeating the same patch.');
      } else if (releaseDare.stopped) {
        emit('validate', 'done', 'Runtime contract repair already ran. Continuing with the current source instead of repeating the same patch.');
      }
    }
    const previewFresh = runtime.status === 'passed' && runtime.health === true;
    if (tests.nodeResult?.status === 'failed' && !previewFresh) {
      throw new Error('Release blocked: the latest saved verification still has a failed runtime test. Tap Run first so the live preview can refresh the test report.');
    }
    if (tests.nodeResult?.status === 'failed' && previewFresh) {
      emit('validate', 'done', 'Live preview already passed. I am using that result instead of the older npm test report.');
      tests.nodeResult = { status: 'passed', runner: 'preview-health', reason: 'Superseded by a passing live preview.' };
      await projects.saveMetadata(project, 'test-plan.json', { ...tests, verifiedAt: new Date().toISOString() });
    }

    await stampMadeBy(source, cfg);
    const quality = await review(project);
    let aiDescription = '';
    try {
      const desc = await ai.completeJson({ task: 'DESCRIPTION', system: SYSTEM, prompt: descriptionPrompt(project), projectId: project.id });
      aiDescription = String(desc.json?.description || '').trim();
    } catch { /* deterministic fallback below */ }
    const notes = await releases.prepareNotes(project, source, quality);

    let githubPublish = null;
    let githubUrl = null;
    let imageVerification = { ok: false };
    let workflowRun = null;
    let workflowDiagnostics = null;
    let autoRepair = null;

    const pending = await projects.readMetadata(project, 'release-pending.json', null);
    const verifyOnly = Boolean(pending?.githubUrl)
      && payload.existingAction !== 'overwrite'
      && payload.forcePublish !== true
      && (
        payload.verifyImage === true
        || payload.recheck === true
        || pending.status === 'workflow_failed'
        || pending.status === 'waiting_image'
      );
    if (verifyOnly) {
      githubUrl = pending.githubUrl;
      githubPublish = { ok: true, verified: true, owner: pending.owner, repo: pending.repo, url: pending.githubUrl, sha: pending.sha };
      emit('github', 'done', 'GitHub source is already verified. Checking the matching Actions run…');
    } else if (github.configured() && payload.push !== false) {
      emit('github', 'running', 'Publishing source…');
      githubPublish = await publishToGitHub({
        github,
        project,
        sourceDir: source,
        version: notes.version,
        emit,
        runtimeOk: runtime.health === true && runtime.status === 'passed',
        repoName: payload.repoName || pending?.repo || project.slug,
        existingAction: payload.existingAction || (pending?.repo ? 'overwrite' : 'confirm'),
      });
      githubUrl = githubPublish.ok && githubPublish.verified ? githubPublish.url : null;
      if (githubPublish.code === 'REPO_EXISTS') {
        return {
          status: 'needs_repository_choice', githubUrl: githubPublish.url || null, githubPublish,
          installReady: false, checklist: ['✓ Build', '✓ Test', '• GitHub', '• GHCR', '• SoloHost'],
          repoChoice: true, choices: githubPublish.choices || [], guide: { step: 3, title: 'Choose the repository action', action: 'publish', label: '🚀 Publish', detail: 'Choose Overwrite to replace the existing repository, or Create new repository to keep it unchanged.' },
          brief: `RESULT: GitHub needs your choice.\nDONE: The app passed the pre-publish checks.\nMISSING: Choose Overwrite or Create new repository.\nNEXT: Choose one option below.`,
          next: 'Choose Overwrite or Create new repository.',
        };
      }
      if (!githubPublish.ok) {
        const zipFail = await createProjectZip({ sourceDir: source, outputDir: path.join(projects.projectDir(project), 'artifacts'), slug: project.slug, kind: 'project' }).catch(() => null);
        return {
          status: 'blocked', githubUrl: null, githubPublish, installReady: false,
          checklist: ['✓ Build', '✓ Test', '✗ GitHub', '• GHCR', '• SoloHost'],
          downloads: [
            ...(zipFail ? [{ kind: 'project', filename: zipFail.filename, url: `/api/projects/${project.id}/download?kind=project` }] : []),
            { kind: 'github-fallback', filename: 'GitHub-ZIP-Image-Publisher-v5.0.ps1', url: `/api/projects/${project.id}/github-fallback` },
          ],
          fallback: { ...(githubPublish.fallback || {}), scriptUrl: `/api/projects/${project.id}/github-fallback`, scriptFilename: 'GitHub-ZIP-Image-Publisher-v5.0.ps1' },
          brief: [githubPublish.error, githubPublish.fix].filter(Boolean).join('\n'),
          next: 'GitHub source was not verified. Fix the GitHub access shown above, then tap Publish once.',
        };
      }
    } else {
      githubPublish = { ok: false, code: 'GITHUB_NOT_CONFIGURED', error: 'GitHub authorization is required.', fallback: { action: 'download', label: 'Download Project' } };
    }

    const owner = githubPublish?.owner || pending?.owner || cfg.github.owner || 'YOUR_GITHUB';
    const repo = githubPublish?.repo || pending?.repo || project.slug;
    // Prefer the immutable commit SHA tag for the install kit. The workflow
    // smoke-tests that exact commit and SoloHost will never accidentally reuse
    // a stale image carrying the same human version tag. Keep the version tag
    // as a fallback for older/pending releases where a commit SHA is unknown.
    let imageTag = githubPublish?.sha || pending?.sha || notes.version;
    imageTag = /^[0-9a-f]{40}$/i.test(String(imageTag)) ? String(imageTag).toLowerCase() : notes.version;
    let registryImage = `ghcr.io/${owner}/${repo}:${imageTag}`.toLowerCase();

    async function savePending(extra = {}) {
      await projects.saveMetadata(project, 'release-pending.json', {
        owner, repo, githubUrl, version: notes.version, sha: githubPublish?.sha || pending?.sha || null,
        image: registryImage, createdAt: pending?.createdAt || new Date().toISOString(),
        autoRepairAttempts: Number(pending?.autoRepairAttempts || 0), ...extra,
      });
    }

    if (githubUrl) {
      await savePending({ status: 'waiting_image' });
      for (let cycle = 0; cycle < 2; cycle += 1) {
        emit('docker-publish', 'running', cycle === 0 ? 'Checking GitHub Actions → GHCR image…' : 'Re-checking the repaired GitHub Actions build…');
        const wait = await waitForGithubImage({ repo, owner, imageTag: imageTag, headSha: githubPublish?.sha || pending?.sha || null, emit });
        imageVerification = wait.imageVerification || { ok: false };
        workflowRun = wait.workflowRun || null;
        workflowDiagnostics = wait.diagnostics || null;
        if (wait.ok) break;
        if (wait.pending) {
          await savePending({ status: 'waiting_image', workflowRun: workflowRun || null, lastCheckedAt: new Date().toISOString() });
          const detail = 'GitHub source is uploaded. The matching image is still building. Tap Check image when GitHub Actions finishes.';
          emit('release', 'done', detail);
          return {
            status: 'waiting_github_actions', release: null, quality, githubUrl, githubPublish, installReady: false,
            checklist: ['✓ Build', '✓ Test', '✓ GitHub', '• GHCR', '• SoloHost'], image: registryImage,
            imageVerification, workflowRun, workflowDiagnostics, autoRepair,
            guide: { step: 4, title: 'Waiting for the GHCR image', action: 'publish', label: '🔄 Check image', detail },
            next: detail, brief: `RESULT: GitHub source is verified.\nMISSING: ${registryImage}\nNEXT: Wait for GitHub Actions to finish, then tap Check image.`,
          };
        }

        if (!wait.failed) break;
        const attempts = Number((pending?.autoRepairAttempts || autoRepair?.attempts || 0));
        if (attempts >= 1 || cycle >= 1 || payload.verifyImage === true) break;
        autoRepair = await repairGithubActionsFailure({ project, source, owner, repo, version: notes.version, githubUrl, workflowRun, diagnostics: workflowDiagnostics, emit, notes, projectPayload: payload });
        if (!autoRepair?.ok) break;
        if (!pending || typeof pending !== 'object') pending = {};
        pending.autoRepairAttempts = 1;
        githubPublish = autoRepair.githubPublish || githubPublish;
        githubUrl = githubPublish?.url || githubUrl;
        if (/^[0-9a-f]{40}$/i.test(String(githubPublish?.sha || ''))) {
          imageTag = String(githubPublish.sha).toLowerCase();
          registryImage = `ghcr.io/${owner}/${repo}:${imageTag}`.toLowerCase();
        }
        await savePending({ status: 'waiting_image', autoRepairAttempts: 1, sha: githubPublish?.sha || null, image: registryImage });
      }
    }

    const imageOk = Boolean(imageVerification.ok);
    if (!imageOk) {
      await savePending({ status: workflowDiagnostics ? 'workflow_failed' : 'waiting_image', workflowRun, diagnostics: workflowDiagnostics, autoRepairAttempts: autoRepair?.attempts || pending?.autoRepairAttempts || 0, lastCheckedAt: new Date().toISOString() });
      const classified = classifyLogs(workflowDiagnostics?.logTail || imageVerification?.error || '') || {};
      const logExcerpt = String(workflowDiagnostics?.logTail || imageVerification?.error || '').split(/\n/).slice(-18).join('\n').slice(-1800);
      const diagnosisText = workflowDiagnostics
        ? [
            workflowDiagnostics.summary,
            classified.title,
            classified.hint,
            workflowDiagnostics.run?.html_url ? `Run: ${workflowDiagnostics.run.html_url}` : '',
            logExcerpt,
          ].filter(Boolean).join('\n')
        : (imageVerification?.error || 'The image is not visible in GHCR yet.');
      const detail = workflowDiagnostics
        ? `GitHub Actions failed.\n${classified.title || workflowDiagnostics.summary}\n${classified.hint || ''}\n${logExcerpt || 'No readable log lines were returned.'}`
        : 'GitHub Actions is still building or GHCR has not finished indexing the image.';
      emit('release', 'done', detail);
      return {
        status: workflowDiagnostics ? 'github_actions_failed' : 'waiting_github_actions', release: null, quality, githubUrl, githubPublish,
        installReady: false, checklist: ['✓ Build', '✓ Test', '✓ GitHub', '✗ GHCR', '• SoloHost'], image: registryImage,
        imageVerification, workflowRun, workflowDiagnostics, autoRepair, diagnosis: diagnosisText,
        guide: { step: 4, title: workflowDiagnostics ? 'Fix the GitHub Actions build' : 'Waiting for the GHCR image', action: 'publish', label: workflowDiagnostics ? '🚀 Re-check build' : '🔄 Check image', payload: { approved: true, confirm: true, push: true, verifyImage: true }, detail: workflowDiagnostics ? `${String(detail).slice(0, 500)}\nRe-check reads the latest Actions result and does not upload source again.` : detail },
        next: workflowDiagnostics ? 'Read the Actions error above. Fix that cause, then tap Re-check build.' : 'Wait for GitHub Actions, then tap Check image.',
        brief: `RESULT: GitHub source is verified.\nWHY: ${String(detail).slice(0, 900)}\nMISSING: ${registryImage}\nNEXT: ${workflowDiagnostics ? 'Do not republish until the Actions error above is fixed. Tap Re-check build to read the latest run.' : 'Tap Check image when the build finishes.'}`,
      };
    }

    try { await github.setContainerPublic(`${owner}/${repo}`); } catch {}
    await github.createRelease(repo, notes.version, notes.notes).catch((err) => log.warn('GitHub release notes failed', { error: String(err.message || err).replace(/ghp_[A-Za-z0-9]+/g, 'ghp_***') }));

    // IMPORTANT: do not create or offer the SoloHost install kit before the exact
    // GHCR image tag has been verified. This removes the previous race condition.
    emit('package', 'running', 'GHCR image verified. Creating the SoloHost install kit…');
    const packageInfo = await releases.prepareSoloHost(project, source, registryImage, aiDescription);
    const validation = await releases.validateSoloHost(source);
    if (validation?.ok === false) throw new Error(`SoloHost package validation failed: ${(validation.errors || []).join(' ')}`);
    const zip = await createProjectZip({ sourceDir: source, outputDir: path.join(projects.projectDir(project), 'artifacts'), slug: project.slug, kind: 'solohost' }).catch(() => null);
    const installReady = Boolean(validation?.ok !== false && runtime.health && githubUrl && imageOk && zip);
    const status = installReady ? 'released' : 'github_published';
    const rec = releases.record(project, { version: notes.version, notes: notes.notes, githubUrl, status });
    projects.setStatus(project, installReady ? 'RELEASED' : 'WAITING_APPROVAL');
    await fs.rm(path.join(projects.projectDir(project), 'metadata', 'release-pending.json'), { force: true }).catch(() => {});

    const checklist = ['✓ Build', runtime.health ? '✓ Test' : '• Test', githubUrl ? '✓ GitHub' : '✗ GitHub', imageOk ? '✓ GHCR' : '✗ GHCR', installReady ? '✓ SoloHost' : '• SoloHost'];
    const next = installReady
      ? 'Download the SoloHost ZIP → import it in SoloHost → save any requested settings → Start the app.'
      : 'GHCR is verified, but the SoloHost ZIP was not created. Use Zip to retry packaging.';
    if (installReady) emit('release', 'done', 'GitHub ✓ · GHCR ✓ · SoloHost install kit ✓');
    return {
      status, release: rec, quality, githubUrl, githubPublish, installReady, checklist,
      image: registryImage, imageVerification, workflowRun, workflowDiagnostics, autoRepair, soloHostPackage: packageInfo, validation, imageOk,
      downloads: [
        zip ? { kind: 'solohost', filename: zip.filename, url: `/api/projects/${project.id}/download?kind=solohost` } : null,
        { kind: 'project', filename: `${project.slug}-source.zip`, url: `/api/projects/${project.id}/download?kind=project` },
        { kind: 'github-fallback', filename: 'GitHub-ZIP-Image-Publisher-v5.0.ps1', url: `/api/projects/${project.id}/github-fallback` },
      ].filter(Boolean),
      fallback: githubPublish?.fallback || null,
      missing: installReady ? [] : ['SoloHost install kit was not created.'],
      next,
      guide: { step: 5, title: 'Install on SoloHost', action: 'export', payload: { kind: 'solohost' }, label: '⬇ Install kit', detail: '1. Download the SoloHost ZIP. 2. In SoloHost choose Import/Add App and select the ZIP. 3. Save any requested settings and tap Start.' },
      install: githubPublish?.install || null,
      brief: `RESULT: ${installReady ? 'Ready for SoloHost.' : 'GHCR verified, packaging needs retry.'}\nDONE: GitHub source and exact GHCR image are verified.\nNEXT: ${next}`,
    };
  }

  async function waitForGithubImage({ repo, owner, imageTag, headSha, emit }) {
    const deadline = Date.now() + 480000;
    let imageVerification = { ok: false };
    let workflowRun = null;
    let diagnostics = null;
    while (Date.now() < deadline) {
      // When we know the freshly published commit SHA, first bind the check to
      // that exact Actions run. A pre-existing GHCR tag must never satisfy a
      // new release before its own workflow has passed.
      workflowRun = await github.latestWorkflowRun(repo, 'docker.yml', { headSha }).catch(() => null) || workflowRun;
      if (headSha && !workflowRun) {
        emit('docker-publish', 'running', 'Waiting for the GitHub Actions run for this commit…');
        await new Promise((resolve) => setTimeout(resolve, 3000));
        continue;
      }
      if (workflowRun?.status === 'completed' && workflowRun.conclusion && workflowRun.conclusion !== 'success') {
        if (workflowRun.id && typeof github.workflowDiagnostics === 'function') {
          diagnostics = await github.workflowDiagnostics(repo, workflowRun.id).catch((err) => ({ summary: 'Unable to read GitHub Actions logs.', logTail: String(err.message || err) }));
        }
        imageVerification = await github.verifyContainerImage(`${owner}/${repo}`, imageTag).catch((err) => ({ ok: false, error: String(err?.message || err) }));
        return { failed: true, imageVerification: { ...imageVerification, workflow: workflowRun, error: `GitHub Actions finished with ${workflowRun.conclusion}.` }, workflowRun, diagnostics };
      }
      imageVerification = await github.verifyContainerImage(`${owner}/${repo}`, imageTag).catch((err) => ({ ok: false, error: String(err?.message || err) }));
      if (workflowRun?.status === 'completed' && workflowRun.conclusion === 'success' && imageVerification.ok) {
        return { ok: true, imageVerification, workflowRun, diagnostics };
      }
      emit('docker-publish', 'running', workflowRun?.status === 'in_progress' || workflowRun?.status === 'queued' ? `GitHub Actions: ${workflowRun.status}…` : 'Waiting for the matching GHCR tag…');
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    return { pending: true, imageVerification, workflowRun, diagnostics };
  }

  async function repairGithubActionsFailure({ project, source, owner, repo, version, githubUrl, workflowRun, diagnostics, emit, notes, projectPayload }) {
    if (!diagnostics?.logTail) return { ok: false, reason: 'No readable GitHub Actions log.' };
    const classified = classifyLogs(diagnostics.logTail) || {};
    let dareCheckpoint = null;
    try {
      const history = await projects.readMetadata(project, 'dare-history.json', []);
      dareCheckpoint = await snapshots.create(project, 'before-dare-github-actions').catch(() => null);
      const dare = await runDare({ sourceDir: source, logs: diagnostics.logTail, extra: classified, history: Array.isArray(history) ? history : [] });
      await projects.saveMetadata(project, 'dare-history.json', (dare.history || []).slice(-20));
      emit('repair', dare.ok ? 'running' : 'done', formatDareReport(dare));
      if (dare.ok) {
        const republish = await publishToGitHub({
          github, project, sourceDir: source, version, emit,
          runtimeOk: true, repoName: repo, existingAction: 'overwrite', refreshWorkflow: false,
        });
        if (republish.ok && republish.verified) {
          emit('repair', 'done', `${formatDareReport(dare)}\n✓ Re-publish and GitHub verification passed.`);
          return { ok: true, attempts: 1, githubPublish: republish, rootCause: dare.reason, explanation: dare.reason, files: dare.files, dare };
        }
        if (dareCheckpoint?.id) {
          await snapshots.restore(project, dareCheckpoint.id).catch(() => {});
          emit('rollback', 'done', 'The deterministic repair did not produce a verified GitHub result, so the previous checkpoint was restored.');
        }
      }
      if (dare.userAction || dare.stopped) {
        return { ok: false, reason: dare.reason, dare, userAction: dare.userAction };
      }
    } catch (err) {
      if (dareCheckpoint?.id) await snapshots.restore(project, dareCheckpoint.id).catch(() => {});
      emit('repair', 'failed', String(err.message || err).slice(0, 240));
    }
    const logText = String(diagnostics.logTail || '');
    const portHit = logText.match(/running on port\s+(\d+)/i);
    // A generic smoke failure is not enough evidence to edit the workflow.
    // Container crashes (including EACCES) belong to runtime/source diagnosis;
    // only an explicit workflow classification may trigger a workflow patch.
    const workflowSmokeRepairEligible = classified?.code === 'workflow_port_mismatch'
      || classified?.code === 'workflow_smoke_timeout'
      || classified?.code === 'workflow_image_tag_mismatch';
    if (workflowSmokeRepairEligible) {
      const listenPort = portHit ? Number(portHit[1]) : 0;
      emit('repair', 'running', listenPort
        ? `The smoke test missed port ${listenPort}. Updating the GitHub workflow without rewriting the app…`
        : 'Updating the GitHub smoke-test workflow so it finds the built image tag and a listening port…');
      try {
        await writeGithubWorkflow(source, { ...project, version, listenPort });
        const df = path.join(source, 'Dockerfile');
        const current = await fs.readFile(df, 'utf8').catch(() => '');
        if (listenPort && current && !new RegExp(`EXPOSE\\s+${listenPort}\\b`).test(current)) {
          const next = /EXPOSE\s+\d+/.test(current)
            ? current.replace(/EXPOSE\s+\d+/, `EXPOSE ${listenPort}`)
            : `${current.trim()}\nEXPOSE ${listenPort}\n`;
          await fs.writeFile(df, next);
        }
        const republish = await publishToGitHub({
          github, project, sourceDir: source, version, emit,
          runtimeOk: true, repoName: repo, existingAction: 'overwrite', refreshWorkflow: false,
        });
        if (republish.ok && republish.verified) {
          emit('repair', 'done', '✓ GitHub workflow smoke test was updated. Actions will rebuild the image.');
          return { ok: true, attempts: 1, githubPublish: republish, rootCause: classified.title || 'GitHub Actions smoke test', explanation: classified.hint || 'Workflow image tag/port probe updated.', files: ['.github/workflows/docker.yml'] };
        }
      } catch (err) {
        emit('repair', 'failed', String(err.message || err).slice(0, 240));
      }
    }
    const evidence = clampText(`${diagnostics.summary}\nCLASSIFICATION: ${JSON.stringify(classified || {})}\nFAILED JOBS:\n${JSON.stringify(diagnostics.jobs || [])}\nLOG:\n${diagnostics.logTail}`, 16000);
    emit('diagnose', 'running', 'Reading the failed GitHub Actions job and asking AI for the smallest safe fix…');
    let r;
    try {
      const relevant = await collectProjectContext(source);
      r = await ai.completeJson({
        task: 'DEBUGGING',
        system: SYSTEM,
        prompt: `${languageInstruction(project.idea)}\nGITHUB ACTIONS RELEASE FAILURE\nRepository: ${owner}/${repo}\nWorkflow run: ${workflowRun?.html_url || workflowRun?.id || 'unknown'}\n\nEVIDENCE:\n${evidence}\n\nPROJECT FILES:\n${relevant}\n\nREQUIRED RESPONSE:\n- Diagnose the concrete root cause from the Actions log.\n- Prefer workflow/config fixes when the app itself is healthy. Do not change working app code for a CI-only problem.\n- Return only files that are strictly required.\n- Risk must be low for automatic repair.\n- Do not invent secrets, tokens, permissions, or host access.\n${patchPrompt(project, evidence, relevant, 'Fix only the current GitHub Actions build failure. Preserve the working app and SoloHost contract.')}`,
        projectId: project.id,
      });
    } catch (err) {
      emit('diagnose', 'failed', friendlyAiError(err));
      return { ok: false, reason: friendlyAiError(err) };
    }
    const proposed = Array.isArray(r.json?.files) ? r.json.files : [];
    const risk = String(r.json?.risk || 'medium').toLowerCase();
    if (!proposed.length || risk !== 'low') {
      emit('diagnose', 'done', `AI diagnosis: ${String(r.json?.root_cause || classified?.title || 'The workflow failure needs manual review.').slice(0, 240)}`);
      return { ok: false, reason: r.json?.explanation || 'AI did not return a low-risk automatic fix.' };
    }

    const beforeStatic = await runStaticTests(source);
    const beforeNode = await runNodeTests(source, 45000);
    const beforeSecurity = await scanProject(source);
    const checkpoint = await applySafeAiPatch({ sourceDir: source, files: proposed, project, snapshots, reason: 'github-actions-auto-fix' });
    emit('repair', 'running', `Applying one low-risk GitHub Actions repair (${proposed.length} file${proposed.length === 1 ? '' : 's'})…`);
    try {
      const afterStatic = await runStaticTests(source);
      const afterNode = await runNodeTests(source, 45000);
      const afterSecurity = await scanProject(source);
      const worse = failureScore(afterStatic, afterNode) > failureScore(beforeStatic, beforeNode) || afterSecurity.critical > beforeSecurity.critical;
      if (worse) {
        await snapshots.restore(project, checkpoint.snapshot.id).catch(() => {});
        emit('rollback', 'done', 'The automatic Actions repair made verification worse, so the previous working state was restored.');
        return { ok: false, rolledBack: true, reason: 'Verification became worse.' };
      }
      await stampMadeBy(source, cfg);
      const republish = await publishToGitHub({
        github, project, sourceDir: source, version, emit,
        runtimeOk: true, repoName: repo, existingAction: 'overwrite', refreshWorkflow: false,
      });
      if (!republish.ok || !republish.verified) {
        await snapshots.restore(project, checkpoint.snapshot.id).catch(() => {});
        emit('rollback', 'done', 'The repaired source could not be republished safely, so the previous working state was restored.');
        return { ok: false, rolledBack: true, githubPublish: republish, reason: republish.error || 'Re-publish verification failed.' };
      }
      emit('repair', 'done', `✓ Safe repair applied: ${String(r.json?.root_cause || 'GitHub Actions issue fixed.').slice(0, 220)}`);
      return { ok: true, attempts: 1, githubPublish: republish, rootCause: r.json?.root_cause || '', explanation: r.json?.explanation || '', files: proposed.map((f) => f.path) };
    } catch (err) {
      await snapshots.restore(project, checkpoint.snapshot.id).catch(() => {});
      emit('rollback', 'done', 'The automatic GitHub Actions repair did not verify, so the previous working state was restored.');
      return { ok: false, rolledBack: true, reason: String(err.message || err).slice(0, 500) };
    }
  }

  jobs.on('release', async (job, { emit }) => {
    const project = mustProject(job.payload.projectId);
    return runRelease(project, job.payload || {}, emit);
  });


  jobs.on('sandbox_command', async (job, { emit }) => {
    const project = mustProject(job.payload.projectId);
    const command = String(job.payload.command || '').trim();
    if (!command) throw new Error('Sandbox command is empty.');
    emit('sandbox', 'running', `Sandbox: ${command.slice(0, 120)}`);
    const result = await runner.execSandbox({ sourcePath: projects.sourceDir(project.slug), image: job.payload.image || null, command, timeout: Math.min(Number(job.payload.timeout || 120), 300) });
    emit('sandbox', result.status === 'passed' ? 'done' : 'failed', result.status === 'passed' ? 'Sandbox command completed.' : (result.error || 'Sandbox command failed.'));
    return result;
  });

  async function collectPublishedIncidentEvidence(project, message, runtimeNow) {
    const raw = `${message}\n${runtimeNow?.error || ''}\n${runtimeNow?.logs || ''}`;
    if (!/(EACCES|permission denied|cannot find module|ERR_MODULE_NOT_FOUND|process died|container (?:exited|crashed)|did not become reachable|health check.*(?:fail|error)|connection refused|GHCR.*(?:fail|error|denied)|GitHub Actions.*(?:fail|error)|không chạy|lỗi)/i.test(raw)) return null;

    const release = await projects.readMetadata(project, 'release.json', {});
    const pending = await projects.readMetadata(project, 'release-pending.json', {});
    const released = release?.github || {};
    const fromMessage = parseGithubRepoUrl(message);
    const parsedRelease = parseGithubRepoUrl(released?.url || pending?.githubUrl || '');
    const repoInfo = fromMessage || parsedRelease || ((released?.owner && released?.repo) ? { owner: released.owner, repo: released.repo, url: released.url || `https://github.com/${released.owner}/${released.repo}` } : null);

    let workflowRun = null;
    let workflowDiagnostics = null;
    if (repoInfo?.repo && github?.latestWorkflowRun) {
      const headSha = released?.sha || pending?.sha || null;
      workflowRun = await github.latestWorkflowRun(repoInfo.repo, 'docker.yml', { headSha }).catch(() => null);
      if (workflowRun?.status === 'completed' && workflowRun.conclusion && workflowRun.conclusion !== 'success' && workflowRun.id && typeof github.workflowDiagnostics === 'function') {
        workflowDiagnostics = await github.workflowDiagnostics(repoInfo.repo, workflowRun.id).catch((err) => ({
          summary: 'Unable to read GitHub Actions logs.',
          logTail: String(err.message || err),
        }));
      }
    }

    const published = Boolean(released?.verified || released?.url || pending?.githubUrl || repoInfo?.repo);
    const incident = maskSecrets(clampText(raw, 9000));
    const githubEvidence = workflowDiagnostics
      ? maskSecrets(clampText([
        `Repository: ${repoInfo?.owner || ''}/${repoInfo?.repo || ''}`,
        `Workflow: ${workflowRun?.html_url || workflowRun?.id || 'unknown'}`,
        `Status: ${workflowRun?.status || 'unknown'} / ${workflowRun?.conclusion || 'unknown'}`,
        workflowDiagnostics.summary,
        workflowDiagnostics.logTail,
      ].filter(Boolean).join('\n'), 10000))
      : (workflowRun ? `Repository: ${repoInfo?.owner || ''}/${repoInfo?.repo || ''}\nWorkflow: ${workflowRun.html_url || workflowRun.id || 'unknown'}\nStatus: ${workflowRun.status || 'unknown'} / ${workflowRun.conclusion || 'unknown'}` : 'No matching GitHub Actions failure was available.');

    return {
      published,
      repoInfo,
      release,
      pending,
      workflowRun,
      workflowDiagnostics,
      context: `PUBLISHED RUNTIME INCIDENT EVIDENCE\nUser/runtime evidence:\n${incident}\n\nGitHub evidence:\n${githubEvidence}`,
    };
  }

  async function triagePublishedIncident(project, message, runtimeNow, emit) {
    const evidence = await collectPublishedIncidentEvidence(project, message, runtimeNow);
    if (!evidence) return null;
    const source = projects.sourceDir(project.slug);
    const history = await projects.readMetadata(project, 'dare-history.json', []);
    let checkpoint = null;
    try {
      checkpoint = await snapshots.create(project, 'before-published-incident-repair').catch(() => null);
      const dare = await runDare({
        sourceDir: source,
        logs: `${message}\n${runtimeNow?.error || ''}\n${runtimeNow?.logs || ''}\n${evidence.workflowDiagnostics?.logTail || ''}`,
        extra: evidence.workflowRun || {},
        history: Array.isArray(history) ? history : [],
      });
      await projects.saveMetadata(project, 'dare-history.json', (dare.history || []).slice(-20));
      if (dare.stopped) {
        return { handled: false, stopped: true, evidence, dare };
      }
      if (dare.ok || dare.alreadyFixed || dare.next === 'CONTINUE') {
        if (dare.ok) emit('repair', 'done', formatDareReport(dare));
        else emit('repair', 'done', `✓ Deterministic diagnosis complete. ${dare.reason || 'The source already contains the required runtime repair.'}`);
        return {
          handled: true,
          action: evidence.published ? 'publish' : 'run',
          reply: dare.ok
            ? `I found a concrete runtime problem and applied the smallest safe repair. I will verify the published image before reporting success.`
            : `I found the same runtime issue, but the source already contains the required safe repair. I will verify the published image instead of changing the app again.`,
          goal: evidence.published ? 'Verify the published GitHub Actions run and exact GHCR image after the deterministic runtime diagnosis; do not repeat the same source patch.' : 'Run the repaired app and verify health before reporting success.',
          dare,
          evidence,
        };
      }
      if (dare.userAction) {
        return { handled: false, evidence, userAction: true, dare };
      }
      return { handled: false, evidence, dare };
    } catch (err) {
      if (checkpoint?.id) await snapshots.restore(project, checkpoint.id).catch(() => {});
      emit('repair', 'failed', `Deterministic incident repair stopped safely: ${String(err.message || err).slice(0, 220)}`);
      return { handled: false, evidence, error: String(err.message || err).slice(0, 500) };
    }
  }

  jobs.on('builder_chat', async (job, { emit }) => {
    const project = mustProject(job.payload.projectId);
    const message = String(job.payload.message || '').trim();
    if (!message) throw new Error('Write a message first.');
    const userLanguage = detectUserLanguage(message);
    const incomingFiles = Array.isArray(job._files) ? job._files : [];
    for (const file of incomingFiles.slice(0, 8)) if (file?.buffer) await saveAttachment(projects.projectDir(project), file);
    await projects.chat(project, message, 'user', { attachments: incomingFiles.map((f) => f.originalname).filter(Boolean) });
    const source = projects.sourceDir(project.slug);
    const diagnosis = await diagnoseSource(source);
    const runtimeNow = await projects.readMetadata(project, 'runtime.json', {});
    const history = (await projects.chatHistory(project)).slice(-16).map((m) => `${m.role}: ${String(m.message || '').slice(0, 240)}`).join('\n');
    const activity = await projects.readMetadata(project, 'activity.json', []);
    const activityText = (Array.isArray(activity) ? activity.slice(-20) : []).map((a) => `${a.t || ''} ${a.action || ''} ${a.status || ''} ${String(a.detail || '').slice(0, 160)}`).join('\n');
    const handoff = await projects.readMetadata(project, 'handoff.json', {});
    const previousPlan = await projects.readMetadata(project, 'work-plan.json', {});
    const context = await collectProjectContext(source);
    const attachContext = await attachmentContext(projects.projectDir(project));
    const requestedImage = extractGhcrImage(message);
    const installFromImage = Boolean(requestedImage && /(solohost|cài đặt|cai dat|install|docker-compose|config_options|file cài|tạo file|tao file|generate)/i.test(message));
    const incident = await triagePublishedIncident(project, message, runtimeNow, emit);
    const pendingRelease = await projects.readMetadata(project, 'release-pending.json', null);
    const waitingForImage = Boolean(pendingRelease?.githubUrl) && ['waiting_image', 'workflow_failed'].includes(String(pendingRelease?.status || ''));
    const asksPublishStatus = /publish|ghcr|github|check image|re-?check|xuất bản|xuat ban|ảnh|image/i.test(message);
    const incidentContext = incident?.evidence?.context ? `\n${incident.evidence.context}` : '';
    emit('ai', 'running', installFromImage ? 'Preparing SoloHost install files from the GitHub image…' : (incident?.handled ? 'Skipping AI: deterministic repair is being verified…' : 'AI is deciding the next best step…'));
    let r = { json: { action: inferAction(message) || 'reply', reply: '', commands: [] } };
    if (!incident?.handled && waitingForImage && asksPublishStatus) {
      r = {
        json: {
          action: 'publish',
          reply: pendingRelease.status === 'workflow_failed'
            ? 'GitHub already has the source. I will read the latest Actions result instead of editing the app again.'
            : 'GitHub already has the source. I will check whether the GHCR image is ready instead of changing the app.',
          steps: [{ action: 'publish', goal: 'Check the existing GitHub Actions / GHCR image without republishing source.' }],
        },
      };
    } else if (incident?.handled) {
      const verifiedPublishedIncident = Boolean(incident.evidence?.published && incident.evidence?.repoInfo?.repo);
      const needsFreshRun = runtimeNow?.status !== 'passed' || runtimeNow?.health !== true;
      const steps = verifiedPublishedIncident && incident.action === 'publish' && needsFreshRun
        ? [
          { action: 'run', goal: 'Run the repaired app and verify health before republishing the existing release.' },
          { action: 'publish', goal: incident.goal },
        ]
        : [{ action: incident.action, goal: incident.goal }];
      r = { json: { action: incident.action, reply: incident.reply, commands: [], steps } };
    } else {
      try {
        if (!installFromImage) {
          r = await ai.completeJson({
            task: 'USER_CHAT',
            system: SYSTEM,
            prompt: builderChatPrompt(project, message, `${languageInstruction(message)}\nHANDOFF:\n${JSON.stringify(handoff)}\nCURRENT WORK PLAN:\n${JSON.stringify(previousPlan)}\nACTIVITY LOG:\n${activityText}\nHISTORY:\n${history}\nDIAGNOSIS:\n${JSON.stringify(diagnosis)}\nRUNTIME:\n${JSON.stringify({ status: runtimeNow.status, error: runtimeNow.error, previewPath: runtimeNow.previewPath })}\n${incidentContext}\n${context}\n${attachContext}`, await attachmentList(projects.projectDir(project))),
            projectId: project.id,
            images: [...imageInputs(incomingFiles), ...(await imageInputsFromAttachments(projects.projectDir(project)))],
          });
        } else {
          r = { json: { action: 'export', reply: `Creating SoloHost install files for ${requestedImage}.`, commands: [], steps: [{ action: 'export', goal: message }] } };
        }
      } catch (err) {
        emit('ai', 'failed', friendlyAiError(err));
      }
    }
    let action = String(r.json?.action || inferAction(message) || 'reply');
    if (installFromImage) action = 'export';
    const failureLayer = classifyFailureLayer(message);
    if (failureLayer.layer && failureLayer.layer !== 'GENERATED_APP' && failureLayer.codeChange === false && action === 'improve') {
      action = 'analyze';
    }
    if (action === 'reply') {
      const inferred = inferAction(message);
      if (inferred && inferred !== 'reply') action = inferred;
    }
    const gated = gateAction(action, { files: diagnosis.files, runtime: runtimeNow, githubConfigured: github.configured(), imageRef: requestedImage });
    if (gated.lock) action = gated.action;
    const reply = [gated.lock, String(r.json?.reply || '')].filter(Boolean).join('\n');
    const skipped = [];
    for (const command of Array.isArray(r.json?.commands) ? r.json.commands.slice(0, 4) : []) {
      if (!command?.command) continue;
      if (isHostDockerCommand(command.command) || isNpmOnEmptyRisk(command.command)) {
        skipped.push(command.command);
        emit('sandbox', 'done', `Skipped raw command. I will use the built-in ${action} script instead.`);
        continue;
      }
    }
    let payload = { projectId: project.id, action, reply, skipped, reports: [] };
    const planned = [];
    if (Array.isArray(r.json?.steps) && r.json.steps.length > 1) {
      for (const step of r.json.steps.slice(0, 5)) {
        planned.push({ action: String(step.action || inferAction(step.goal || '') || action), goal: String(step.goal || message) });
      }
    } else {
      const pieces = splitUserSteps(message);
      if (pieces.length > 1) planned.push(...pieces.map((goal) => ({ action: inferAction(goal) || action, goal })));
      else planned.push({ action, goal: String(r.json?.feedback || message) });
    }
    const workPlan = await projects.startWorkPlan(project, {
      jobId: job.id,
      message,
      action,
      language: userLanguage,
      steps: planned.map((step) => ({ ...step, tests: step.action === 'improve' ? ['static checks', 'runtime tests', 'security scan', 'preview'] : [] })),
    });
    payload = { projectId: project.id, action, reply, skipped, reports: [], workPlanId: workPlan.id };
    emit('plan', 'done', `Plan ready: ${planned.length} step${planned.length === 1 ? '' : 's'}. Each step will be verified and recorded.`);
    // A failed prerequisite must not be followed by a dependent Run/Publish.
    // Independent safe analysis steps may still continue, but never let a later
    // successful preview hide an earlier failed repair.
    let prerequisiteFailed = false;
    if (action === 'question' && Array.isArray(r.json.questions) && r.json.questions.length) {
      await projects.saveMetadata(project, 'chat-question.json', { questions: r.json.questions });
      projects.setStatus(project, 'WAITING_INPUT');
      payload.questions = r.json.questions;
    } else {
      for (const [stepIndex, step] of planned.entries()) {
        const planStep = workPlan.steps[stepIndex];
        let stepAction = step.action;
        if (prerequisiteFailed && ['run', 'publish', 'export'].includes(stepAction)) {
          payload.reports.push({ action: stepAction, status: 'blocked', goal: step.goal, error: 'Blocked because the previous repair/build step failed.' });
          await projects.updateWorkPlan(project, {
            stepId: planStep.id,
            step: { status: 'blocked', error: 'Blocked because a previous required step failed.' },
            reports: payload.reports,
          });
          emit(stepAction, 'failed', `Skipped ${stepAction}: the previous required step failed. Fix that issue first.`);
          continue;
        }
        const gatedStep = gateAction(stepAction, { files: diagnosis.files, runtime: runtimeNow, githubConfigured: github.configured(), imageRef: requestedImage || extractGhcrImage(step.goal) });
        if (gatedStep.lock) stepAction = gatedStep.action;
        await projects.updateWorkPlan(project, { stepId: planStep.id, step: { status: 'running', action: stepAction } });
        try {
          if (stepAction === 'build') {
            emit('build', 'running', `Step: write files — ${step.goal.slice(0, 80)}`);
            const analysis = await projects.readMetadata(project, 'requirements.json', {});
            const plan = await projects.readMetadata(project, 'architecture.json', {});
            payload.built = await generateCode({ project, analysis, plan, emit, allowFallback: false });
          } else if (stepAction === 'improve') {
            emit('improve', 'running', `Step: targeted patch — ${step.goal.slice(0, 80)}`);
            await snapshots.create(project, 'before-step-improve').catch(() => {});
            payload.result = await improveProject(project, step.goal, emit);
          } else if (stepAction === 'run') {
            payload.runtime = await runWithRepair(project, emit, step.goal);
          } else if (stepAction === 'analyze') {
            emit('analyze', 'running', 'Checking files, crash logs, and security without changing code…');
            payload.tested = await inspectOnly(project, emit);
            payload.diagnosis = payload.tested.diagnosis || await diagnoseSource(source);
            if (runtimeNow.logs) payload.crash = classifyLogs(runtimeNow.logs || runtimeNow.error || '');
            const layerNow = classifyFailureLayer(step.goal || message);
            payload.layer = layerNow.layer || 'UNKNOWN';
            payload.layerReport = formatLayerDiagnosis({
              layer: payload.layer,
              message: step.goal || message,
              crash: payload.crash,
              next: layerNow.ask || 'I will not change app code until this layer is confirmed.',
            });
            emit('analyze', 'done', payload.layerReport);
          } else if (stepAction === 'export') {
            const image = extractGhcrImage(step.goal) || extractGhcrImage(message);
            const kind = image || /install|solohost|config|cài đặt|solo\s*host/i.test(step.goal) ? 'solohost' : 'project';
            if (image) {
              const ports = guessSoloHostPorts(step.goal, image);
              emit('release', 'running', `Writing SoloHost files for ${image}`);
              await writeSoloHostPackage({
                project,
                sourceDir: projects.sourceDir(project.slug),
                image,
                hostPort: ports.hostPort,
                containerPort: ports.containerPort,
              });
              payload.image = image;
              payload.installReady = true;
            }
            const artifact = await createProjectZip({ sourceDir: projects.sourceDir(project.slug), outputDir: path.join(projects.projectDir(project), 'artifacts'), slug: project.slug, kind });
            payload.downloads = [
              { kind, filename: artifact.filename, url: `/api/projects/${project.id}/download?kind=${kind}` },
              { kind: 'github-fallback', filename: 'GitHub-ZIP-Image-Publisher-v5.0.ps1', url: `/api/projects/${project.id}/github-fallback` },
            ];
          } else if (stepAction === 'publish') {
            emit('release', 'running', 'Publishing the app now…');
            const autoRepairRelease = Boolean(incident?.handled && incident?.evidence?.published && incident?.evidence?.repoInfo?.repo);
            payload.result = await runRelease(project, {
              approved: true,
              confirm: true,
              push: true,
              verifyImage: waitingForImage || payload.verifyImage === true,
              existingAction: autoRepairRelease ? 'overwrite' : 'confirm',
              repoName: autoRepairRelease ? incident.evidence.repoInfo.repo : undefined,
            }, emit);
            payload.publish_ready = payload.result?.status === 'released' || payload.result?.status === 'packaged';
          }
          let stepStatus = 'done';
          let stepError = '';
          if (stepAction === 'run' && payload.runtime?.status !== 'passed') {
            stepStatus = 'failed';
            stepError = payload.runtime?.error || 'Run did not produce a verified healthy runtime.';
          }
          if (stepAction === 'publish') {
            const publishStatus = String(payload.result?.status || '');
            if (publishStatus === 'waiting_github_actions' || publishStatus === 'needs_repository_choice') {
              stepStatus = 'waiting';
              stepError = payload.result?.next || 'Publish is waiting for the next required user/action step.';
            } else if (!['released', 'packaged'].includes(publishStatus)) {
              stepStatus = 'failed';
              stepError = payload.result?.brief || payload.result?.next || 'Publish did not reach a verified release state.';
            }
          }
          if (stepStatus === 'failed') prerequisiteFailed = true;
          payload.reports.push({ action: stepAction, status: stepStatus === 'waiting' ? 'blocked' : stepStatus, goal: step.goal, error: stepError });
          await projects.updateWorkPlan(project, {
            stepId: planStep.id,
            step: {
              status: stepStatus,
              action: stepAction,
              files: payload.result?.files || payload.built?.files || [],
              error: stepError || undefined,
              result: stepAction === 'improve' ? (payload.result?.explanation || 'Patch verified.') : (stepStatus === 'done' ? `${stepAction} completed.` : stepError),
            },
            reports: payload.reports,
          });
          if (stepStatus === 'done') emit(stepAction, 'done', `${stepAction} completed and verified.`);
          else if (stepStatus === 'waiting') emit(stepAction, 'done', stepError);
          else emit(stepAction, 'failed', stepError);
        } catch (err) {
          const error = String(err.message || err).slice(0, 240);
          payload.reports.push({ action: stepAction, status: 'failed', goal: step.goal, error });
          prerequisiteFailed = true;
          await projects.updateWorkPlan(project, {
            stepId: planStep.id,
            step: { status: 'failed', action: stepAction, error, notes: ['Dependent steps were blocked after this failure.'] },
            reports: payload.reports,
          });
          emit(stepAction, 'failed', `Step failed: ${error}`);
        }
      }
    }
    const planStatus = action === 'question' ? 'waiting_input' : (payload.reports.some((item) => item.status === 'failed' || item.status === 'blocked') ? 'failed' : 'done');
    const finishedPlan = await projects.finishWorkPlan(project, planStatus, planStatus === 'done'
      ? 'All planned steps completed and were recorded. Continue from this report instead of repeating earlier work.'
      : planStatus === 'waiting_input'
        ? 'Waiting for the user choices before build can continue.'
        : 'One or more steps failed. Completed work was kept only after verification; dependent steps were blocked.');
    payload.workPlan = finishedPlan;
    const latestRuntime = payload.runtime || payload.result?.runtime || await projects.readMetadata(project, 'runtime.json', {});
    if (action !== 'run') {
      await gcDocker({ keepImage: null, keepContainer: null, log }).catch(() => {});
    } else {
      await gcDocker({ keepImage: latestRuntime.image || null, keepContainer: latestRuntime.status === 'passed' ? latestRuntime.container : null, log }).catch(() => {});
    }
    payload.guide = payload.result?.guide || guideCard({ runtime: latestRuntime, findings: diagnosis.findings, action, publishReady: payload.publish_ready });
    payload.next = payload.guide.detail;
    payload.brief = formatUserBrief({ action, runtime: latestRuntime, diagnosis, reply, next: payload.next, language: userLanguage, reports: payload.reports });
    if (payload.layerReport) payload.brief = `${payload.layerReport}\n${payload.brief || ''}`.trim();
    await gcDocker({ keepImage: latestRuntime.image || null, keepContainer: latestRuntime.status === 'passed' ? latestRuntime.container : null, log }).catch(() => {});
    await projects.chat(project, payload.brief, 'assistant', { action, next: payload.next });
    const failCard = describeFailure({
      error: latestRuntime.error || payload.reports.find((s) => s.status === 'failed')?.error || '',
      logs: latestRuntime.logs || '',
      findings: diagnosis.findings || [],
      action,
    });
    payload.fix = failCard.fix;
    payload.copyForAi = latestRuntime.status === 'passed' ? null : failCard.copy;
    const prevActivity = Array.isArray(activity) ? activity : [];
    await projects.saveMetadata(project, 'activity.json', [
      ...prevActivity,
      {
        t: new Date().toISOString(),
        action,
        status: latestRuntime.status || (payload.reports.some((s) => s.status === 'failed') ? 'failed' : 'done'),
        detail: failCard.what,
        next: payload.next,
      },
    ].slice(-40));
    await projects.saveMetadata(project, 'handoff.json', {
      updatedAt: new Date().toISOString(),
      userLanguage,
      lastUserMessage: message,
      lastAction: action,
      lastBrief: payload.brief,
      next: payload.next,
      runtime: { status: latestRuntime.status, previewPath: latestRuntime.previewPath, error: latestRuntime.error },
      files: diagnosis.files.slice(0, 40),
      workPlan: {
        id: finishedPlan.id,
        status: finishedPlan.status,
        steps: finishedPlan.steps.map((item) => ({ id: item.id, action: item.action, goal: item.goal, status: item.status, files: item.files, error: item.error })),
      },
    });
    emit('guide', 'done', payload.next);
    return payload;
  });

  jobs.on('ask', async (job) => {
    const project = mustProject(job.payload.projectId);
    const question = String(job.payload.question || '').trim();
    if (!question) throw new Error('Ask a question first.');
    const userLanguage = detectUserLanguage(question);
    const files = await projects.sourceFiles(project);
    const context = clampText(`files: ${files.join(', ')}`, 4000);
    try {
      const r = await ai.completeJson({
        task: 'USER_CHAT',
        system: SYSTEM,
        prompt: `${languageInstruction(question)}\n${chatPrompt(project, question, context)}`,
        projectId: project.id,
      });
      return r.json;
    } catch (err) {
      return { reply: `AI response unavailable. ${friendlyAiError(err)}`, proposed_change: null, userLanguage };
    }
  });

  jobs.on('import_app', async (job, { emit }) => {
    const buf = job._zip;
    if (!buf) throw new Error('Upload a ZIP file.');
    emit('import', 'running', 'Reading the uploaded app…');
    let project;
    if (job.payload.projectId) {
      project = mustProject(job.payload.projectId);
      emit('snapshot', 'running', 'Saving a restore point…');
      await snapshots.create(project, 'before-zip-import');
    } else {
      const analysis = localAnalysis(job.payload.idea || job.payload.filename || 'Imported app');
      const plan = localPlan(job.payload.idea || 'Imported existing application', analysis);
      project = await projects.create({
        idea: job.payload.idea || `Imported ${job.payload.filename || 'app.zip'}`,
        name: analysis.name,
        analysis,
        plan,
      });
      jobs.attachProject(job.id, project.id);
    }
    const dest = projects.sourceDir(project.slug);
    let stack;
    try {
      stack = await importZipBuffer(buf, dest, { replace: true });
    } catch (err) {
      // A replacement import is destructive to source, so restore the latest
      // checkpoint if unpacking/validation fails. New projects have no prior
      // checkpoint and can simply fail without affecting another project.
      if (job.payload.projectId) {
        const latest = snapshots.list(project.id)[0];
        if (latest?.id) await snapshots.restore(project, latest.id).catch(() => {});
      }
      throw err;
    }
    await projects.saveMetadata(project, 'requirements.json', { ...(await projects.readMetadata(project, 'requirements.json', {})), stack, imported: true, filename: job.payload.filename });
    await projects.saveMetadata(project, 'user-language.json', { language: detectUserLanguage(job.payload.idea || job.payload.filename || 'Imported app'), source: job.payload.idea || job.payload.filename || 'Imported app' });
    projects.setStatus(project, 'READY_TO_BUILD');
    emit('scan', 'running', 'Checking the imported files…');
    const tested = await testAndMaybeFix(projects.get(project.id), emit);
    return { projectId: project.id, stack, tested, summary: `Imported ${job.payload.filename || 'ZIP'}. Stack: ${stack.language}. Docker: ${stack.docker ? 'yes' : 'no'}.` };
  });

  jobs.on('apply_patch', async (job, { emit }) => {
    const project = mustProject(job.payload.projectId);
    const files = job.payload.files || [];
    emit('snapshot', 'running', 'Saving a restore point…');
    await snapshots.create(project, 'before-patch');
    emit('patch', 'running', 'Applying the change…');
    const checkpoint = await applySafeAiPatch({ sourceDir: projects.sourceDir(project.slug), files, project, snapshots, reason: 'apply-patch' });
    await stampMadeBy(projects.sourceDir(project.slug), cfg);
    await writeGithubWorkflow(projects.sourceDir(project.slug), project);
    const verified = await testAndMaybeFix(projects.get(project.id), emit);
    const failed = verified.staticResult?.status === 'failed' || verified.nodeResult?.status === 'failed' || verified.scan?.critical > 0 || verified.dockerBuild?.status === 'failed';
    if (failed && checkpoint?.snapshot?.id) {
      await snapshots.restore(project, checkpoint.snapshot.id).catch(() => {});
      emit('rollback', 'done', 'The explicit patch did not verify as a complete step forward, so the previous checkpoint was restored.');
      throw new Error('PATCH_ROLLED_BACK: the requested change did not pass verification. The previous working state is restored.');
    }
    return verified;
  });

  jobs.on('sandbox_demo', async (job, { emit }) => {
    emit('sandbox', 'running', 'Loading the Sandbox Benchmark demo…');
    const src = path.resolve(cfg.templatesDir || 'templates', 'sandbox-benchmark');
    const analysis = localAnalysis('Sandbox App Benchmark');
    const plan = localPlan('Prove HTML, JS, HTTP, filesystem and CPU in the preview sandbox.', analysis);
    const project = await projects.create({
      idea: 'Sandbox App Benchmark — prove preview before building a product app',
      name: 'Sandbox Benchmark',
      analysis,
      plan,
    });
    jobs.attachProject(job.id, project.id);
    const dest = projects.sourceDir(project.slug);
    await fs.cp(src, dest, { recursive: true });
    await stampMadeBy(dest, cfg).catch(() => {});
    emit('run', 'running', 'Starting the sandbox preview…');
    const runtime = await runProject(project, emit);
    await projects.saveMetadata(project, 'sandbox-probe.json', {
      ok: runtime.status === 'passed',
      at: new Date().toISOString(),
      previewPath: runtime.previewPath,
      error: runtime.error || null,
      internet: runtime.internet || null,
      interpretation: runtime.internet?.ok === false
        ? 'Sandbox outbound Internet is unavailable or blocked; diagnose the environment before changing product code.'
        : runtime.internet?.ok === true
          ? 'Sandbox outbound Internet is reachable; app-specific browsing issues should be diagnosed in the product gateway/proxy.'
          : 'Internet result unavailable.'
    });
    return {
      projectId: project.id,
      runtime,
      ui_url: runtime.previewPath,
      next: runtime.status === 'passed'
        ? 'Sandbox preview is ready. Open the test link, then build your own app.'
        : 'Sandbox preview failed. Fix Builder/preview first — this is not a product-app bug.',
    };
  });

  async function generateCode({ project, analysis, plan, emit, allowFallback = false }) {
    projects.setStatus(project, 'BUILDING');
    const dest = projects.sourceDir(project.slug);
    let written = [];
    let usedFallback = false;
    try {
      emit('code', 'running', 'AI is writing the application files…');
      const r = await ai.completeJson({
        task: 'CODING',
        system: SYSTEM,
        prompt: codePrompt(project, plan),
        projectId: project.id,
      });
      if (!r.json?.files?.length) throw new Error('AI did not return files');
      written = await writeGeneratedFiles(dest, r.json.files);
    } catch (err) {
      if (!allowFallback) throw new Error(`AI code generation failed: ${friendlyAiError(err)}`);
      usedFallback = true;
      emit('code', 'running', 'Loading the optional demo starter…');
      written = await scaffoldFromTemplate(cfg.templatesDir, dest, {
        name: project.name, slug: project.slug, summary: analysis.summary || project.idea, idea: project.idea,
      });
      log.warn('Code generation used template', { error: err.message });
    }
    await stampMadeBy(dest, cfg);
    await ensureMissingDependencies(dest).catch(() => ({ changed: false }));
    await writeGithubWorkflow(dest, project);
    await snapshots.create(project, 'after-generate');
    const pkg = await writeSoloHostPackage({
      project,
      sourceDir: dest,
      image: `paf-app:${project.slug}`,
      hostPort: 18080,
    }).catch(() => null);
    const tested = await testAndMaybeFix(projects.get(project.id), emit);
    const imageFile = tested.imageFile?.status === 'passed' ? tested.imageFile : null;
    return { files: written, fallback: usedFallback, tested, e2e: tested.e2e || null, image: null, imageFile: null, downloads: [], next: tested.next };
  }

  async function testAndMaybeFix(project, emit) {
    const source = projects.sourceDir(project.slug);
    emit('test', 'running', 'Checking that the files look complete…');
    projects.setStatus(project, 'TESTING');
    let staticResult = await runStaticTests(source);
    let nodeResult = await runNodeTests(source, 45000);
    let attempts = 0;
    let dareAttempts = 0;
    const dareHistory = await projects.readMetadata(project, 'dare-history.json', []);
    let savedDareHistory = Array.isArray(dareHistory) ? dareHistory : [];

    // Deterministic-first: exhaust a provable repair before spending an AI repair attempt.
    // The checkpoint is created before DARE touches source so a regression can be restored.
    while (staticResult.status === 'failed' || nodeResult.status === 'failed') {
      const errText = [failSummary(staticResult), nodeResult.error].filter(Boolean).join('\n');
      if (dareAttempts < 2) {
        dareAttempts += 1;
        emit('repair', 'running', `Checking deterministic fixes first (${dareAttempts}/2)…`);
        const beforeFailureScore = failureScore(staticResult, nodeResult);
        const checkpoint = await snapshots.create(project, `before-dare-${dareAttempts}`).catch(() => null);
        try {
          const dare = await runDare({
            sourceDir: source,
            logs: errText,
            extra: { message: nodeResult.error || '' },
            history: savedDareHistory,
          });
          savedDareHistory = (dare.history || []).slice(-20);
          await projects.saveMetadata(project, 'dare-history.json', savedDareHistory);
          if (dare.ok) {
            const afterStatic = await runStaticTests(source);
            const afterNode = await runNodeTests(source, 45000);
            const afterFailureScore = failureScore(afterStatic, afterNode);
            if (afterFailureScore <= beforeFailureScore) {
              staticResult = afterStatic;
              nodeResult = afterNode;
              emit('repair', 'done', `${formatDareReport(dare)}\n✓ Post-repair checks completed.`);
              if (staticResult.status !== 'failed' && nodeResult.status !== 'failed') break;
              continue;
            }
            if (checkpoint?.id) await snapshots.restore(project, checkpoint.id).catch(() => {});
            emit('rollback', 'done', 'The deterministic repair did not improve verification, so the previous checkpoint was restored.');
            staticResult = await runStaticTests(source);
            nodeResult = await runNodeTests(source, 45000);
          } else if (dare.userAction) {
            emit('repair', 'done', formatDareReport(dare));
            break;
          }
        } catch (err) {
          if (checkpoint?.id) await snapshots.restore(project, checkpoint.id).catch(() => {});
          emit('repair', 'failed', `Deterministic repair check stopped safely: ${String(err.message || err).slice(0, 240)}`);
        }
      }

      if ((staticResult.status !== 'failed' && nodeResult.status !== 'failed') || attempts >= cfg.limits.maxAutoFixes) break;

      attempts += 1;
      emit('repair', 'running', `Trying a safe AI fix (${attempts}/${cfg.limits.maxAutoFixes})…`);
      projects.setStatus(project, 'REPAIRING');
      const relevant = await collectRelevant(source);
      let checkpoint = null;
      try {
        const r = await ai.completeJson({
          task: 'DEBUGGING',
          system: SYSTEM,
          prompt: `${patchPrompt(project, errText, relevant)}\nDETERMINISTIC REPAIR NOTE: DARE has already been attempted for this evidence. Do not repeat the same deterministic patch; change only the minimum files required for a new root cause.`,
          projectId: project.id,
        });
        if (r.json?.files?.length) checkpoint = await applySafeAiPatch({ sourceDir: source, files: r.json.files, project, snapshots, reason: `before-fix-${attempts}` });
      } catch (err) {
        emit('repair', 'failed', friendlyAiError(err));
        break;
      }
      const beforeFailureScore = failureScore(staticResult, nodeResult);
      staticResult = await runStaticTests(source);
      nodeResult = await runNodeTests(source, 45000);
      const afterFailureScore = failureScore(staticResult, nodeResult);
      if (checkpoint?.snapshot?.id && afterFailureScore > beforeFailureScore) {
        await snapshots.restore(project, checkpoint.snapshot.id).catch(() => {});
        emit('rollback', 'done', 'The AI repair made the checks worse, so I restored the previous working state.');
        staticResult = await runStaticTests(source);
        nodeResult = await runNodeTests(source, 45000);
      }
      if (staticResult.status !== 'failed' && nodeResult.status !== 'failed') break;
    }
    emit('security', 'running', 'Looking for secrets and unsafe settings…');
    let scan = await scanProject(source);
    let securityRepair = null;
    // Safe, deterministic gate: if every blocking finding explicitly permits
    // automatic repair, let the repair AI attempt one targeted fix immediately.
    // This keeps ordinary users from having to copy a security report manually.
    if (scan.critical > 0 && scan.findings.every((f) => f.autoFix)) {
      emit('repair', 'running', 'A safe security fix is available. Applying one targeted repair…');
      let securityCheckpoint = null;
      try {
        const relevant = await collectProjectContext(source);
        const r = await ai.completeJson({
          task: 'SECURITY',
          system: SYSTEM,
          prompt: patchPrompt(project, scan.copy_for_ai, relevant, 'Automatically repair the blocking security findings above. Change only the affected files. Preserve all existing app behavior.'),
          projectId: project.id,
        });
        if (!r.json?.files?.length) throw new Error('AI did not return a safe security patch.');
        securityCheckpoint = await applySafeAiPatch({ sourceDir: source, files: r.json.files, project, snapshots, reason: 'before-security-fix' });
        const afterSecurityStatic = await runStaticTests(source);
        const afterSecurityNode = await runNodeTests(source, 45000);
        const afterSecurityScan = await scanProject(source);
        const securityWorse = afterSecurityScan.critical > scan.critical
          || failureScore(afterSecurityStatic, afterSecurityNode) > failureScore(staticResult, nodeResult);
        if (securityWorse || afterSecurityScan.critical > 0) {
          await snapshots.restore(project, securityCheckpoint.snapshot.id).catch(() => {});
          emit('rollback', 'done', 'The automatic security change was not a verified step forward, so the previous checkpoint was restored.');
          scan = await scanProject(source);
          securityRepair = { status: 'rolled_back', files: r.json.files.map((f) => f.path), reason: 'Security/runtime verification did not pass.' };
        } else {
          securityRepair = { status: 'attempted', files: r.json.files.map((f) => f.path) };
          scan = afterSecurityScan;
          staticResult = afterSecurityStatic;
          nodeResult = afterSecurityNode;
          emit('security', 'done', '✓ Security issue fixed and re-scanned.');
        }
      } catch (err) {
        if (securityCheckpoint?.snapshot?.id) await snapshots.restore(project, securityCheckpoint.snapshot.id).catch(() => {});
        securityRepair = { status: 'failed', error: String(err.message || err).slice(0, 500) };
        emit('repair', 'failed', `Security repair could not be applied automatically: ${securityRepair.error}`);
      }
    }
    await projects.saveMetadata(project, 'security.json', { ...scan, repair: securityRepair });
    if (scan.critical > 0) {
      emit('security', 'failed', scan.copy_for_ai);
      throw new Error(`RELEASE_SECURITY_BLOCKED\n${scan.copy_for_ai}\nNEXT: Fix the blocking security issue, then Run/Publish again.`);
    }
    emit('preview', 'running', 'Starting a safe preview without host Docker access…');
    const dockerBuild = await runner.run({ sourcePath: source, projectSlug: project.slug, timeout: cfg.limits.sandboxTimeoutSec });
    const imageFile = null;
    await projects.saveMetadata(project, 'test-plan.json', { staticResult, nodeResult, scan, preview: dockerBuild, dockerBuild, e2e: dockerBuild.e2e || null, imageFile, securityRepair });
    const ok = staticResult.status === 'passed' && nodeResult.status !== 'failed' && scan.critical === 0 && dockerBuild.status === 'passed';
    projects.setStatus(project, ok ? 'WAITING_APPROVAL' : 'FAILED');
    if (ok) emit('test', 'done', '✓ Source checks, security, preview and Playwright E2E passed.');
    return { staticResult, nodeResult, scan, dockerBuild, e2e: dockerBuild.e2e || null, imageFile, autoFixes: attempts, securityRepair, next: ok ? 'Open the preview with Run, Improve if needed, or Publish when ready.' : 'Fix the blocking issue shown above, then Run again.' };
  }

  async function review(project) {
    try {
      const files = await projects.sourceFiles(project);
      const r = await ai.completeJson({
        task: 'CODE_REVIEW',
        system: SYSTEM,
        prompt: reviewPrompt(project, { files }),
        projectId: project.id,
      });
      return r.json;
    } catch {
      const scan = await projects.readMetadata(project, 'security.json', {});
      const tests = await projects.readMetadata(project, 'test-plan.json', {});
      const functionality = tests.staticResult?.status === 'passed' ? 90 : 60;
      const security = scan.critical ? 40 : scan.warning ? 80 : 95;
      return {
        functionality, security, reliability: 88, performance: 86, documentation: 90,
        overall: Math.round((functionality + security + 88 + 86 + 90) / 5),
        verdict: scan.critical ? 'BLOCK' : 'PASS',
        findings: scan.findings || [],
        source: 'heuristic',
      };
    }
  }


  async function releaseFailureGuide(project, error, context = '') {
    const lang = (await projects.readMetadata(project, 'user-language.json', {})).language || detectUserLanguage(project.idea);
    try {
      const r = await ai.completeJson({
        task: 'DEBUGGING',
        system: SYSTEM,
        prompt: `${languageInstructionFor(lang)}\nA release operation failed. App Builder already attempted its own internal automatic retries for transient GitHub state before surfacing this error — so if you are seeing this message, those retries did NOT resolve it. Diagnose it for a non-technical user.\nSTRICT RULES:\n- Do NOT say "I have already fixed it" or "please try again" or "the repository now has content" — those retries already happened and still failed, so repeating that claim would be misleading.\n- Do NOT tell the user to click Publish again as the primary fix unless the error is genuinely transient (rate limit, server error) — for anything else, retrying the same action will fail the same way again.\n- If the error code is 'auth', 'permission', 'PROJECT_EMPTY', or 'BLOCK_PUSH', name the exact thing to check (token scope, repo access, missing files) as the next action.\n- If the error is truly transient (rate_limit, server), say to wait briefly and retry.\n- Keep it to one or two sentences, plain language, one concrete action.\nERROR CODE: ${error?.code || 'unknown'}\nERROR: ${String(error?.message || error).slice(0, 1600)}\nCONTEXT: ${context.slice(0, 2500)}\nReturn JSON: {"reply":"short diagnosis and next action"}.`,
        projectId: project.id,
      });
      return String(r.json?.reply || '').trim();
    } catch { return ''; }
  }

  async function runProject(project, emit) {
    const source = projects.sourceDir(project.slug);
    const runtime = await runner.runApp({ sourcePath: source, projectSlug: project.slug, timeout: cfg.limits.sandboxTimeoutSec, keepRunning: true });
    await projects.saveMetadata(project, 'runtime.json', { ...runtime, image: runtime.image || null, lastSeenAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const tests = await projects.readMetadata(project, 'test-plan.json', {});
    await projects.saveMetadata(project, 'test-plan.json', { ...tests, preview: runtime });
    projects.setStatus(project, runtime.status === 'passed' ? 'WAITING_APPROVAL' : 'FAILED');
    if (runtime.status === 'passed') {
      runtime.previewPath = runtime.previewPath || `/preview/${project.slug}/`;
      runtime.brief = briefRun(runtime);
      emit('run', 'done', `RESULT: App is running. Open ${runtime.previewPath}`);
    } else {
      runtime.brief = briefFail(runtime.error || runtime.reason || 'The app could not start.');
      emit('run', 'failed', runtime.brief);
    }
    return runtime;
  }

  async function inspectOnly(project, emit) {
    const source = projects.sourceDir(project.slug);
    const diagnosis = await diagnoseSource(source);
    const staticResult = await runStaticTests(source);
    const nodeResult = await runNodeTests(source, 45000);
    const scan = await scanProject(source);
    emit('analyze', staticResult.status === 'passed' && nodeResult.status !== 'failed' && scan.critical === 0 ? 'done' : 'failed',
      `INSPECT ONLY: source ${staticResult.status}; runtime tests ${nodeResult.status}; security critical ${scan.critical}.`);
    return { staticResult, nodeResult, scan, diagnosis, inspectOnly: true };
  }

  async function improveProject(project, feedback, emit) {
    const source = projects.sourceDir(project.slug);

    const networkRequest = /\b(internet|offline|online|network|dns|proxy|gateway|browse|browsing|fetch|connection|kết nối|mạng|internet|truy cập web)\b/i.test(String(feedback || ''));
    let networkPreflight = null;
    if (networkRequest) {
      emit('network', 'running', 'Checking Builder network before changing app code…');
      networkPreflight = await checkBuilderInternet();
      if (!networkPreflight.ok) {
        const message = `BUILDER_NETWORK_BLOCKED\n${networkPreflight.summary}\n${networkPreflight.remediation}`;
        emit('network', 'failed', message);
        throw new Error(message);
      }
      emit('network', 'done', `Builder Internet OK (${networkPreflight.httpsOk}/${networkPreflight.targets.length}).`);
    }
    const runtimeState = await projects.readMetadata(project, 'runtime.json', {});
    const problemFingerprint = repairFingerprint({ feedback, runtime: runtimeState });
    const guard = await projects.readMetadata(project, 'action-guard.json', null);

    // Deterministic-first: a concrete runtime fingerprint must go through DARE
    // before AI is allowed to touch source code. This is especially important
    // for SoloHost container failures such as EACCES.
    const dareHistory = await projects.readMetadata(project, 'dare-history.json', []);
    const dareCheckpoint = await snapshots.create(project, 'before-improve-dare').catch(() => null);
    let dare = null;
    try {
      dare = await runDare({
        sourceDir: source,
        logs: `${feedback}\n${runtimeState?.error || ''}\n${runtimeState?.logs || ''}\n${runtimeState?.brief || ''}`,
        extra: runtimeState || {},
        history: Array.isArray(dareHistory) ? dareHistory : [],
      });
      await projects.saveMetadata(project, 'dare-history.json', (dare.history || []).slice(-20));
      if (dare.ok || dare.alreadyFixed || dare.next === 'CONTINUE') {
        if (dare.ok) emit('repair', 'done', formatDareReport(dare));
        else emit('repair', 'done', `✓ Deterministic runtime contract already applied. ${dare.reason || 'No source patch is needed.'}`);
        const afterStatic = await runStaticTests(source);
        const afterNode = await runNodeTests(source, 45000);
        const afterScan = await scanProject(source);
        if (afterStatic.status === 'passed' && afterNode.status !== 'failed' && afterScan.critical === 0) {
          const repairedRuntime = await runProject(projects.get(project.id), emit);
          if (repairedRuntime?.status === 'passed') {
            await projects.saveMetadata(project, 'action-guard.json', null);
            return { feedback, rootCause: dare.reason || '', explanation: dare.reason || 'Deterministic runtime repair verified.', files: dare.files || [], tested: { staticResult: afterStatic, nodeResult: afterNode, scan: afterScan }, runtime: repairedRuntime, dare };
          }
        }
        if (dareCheckpoint?.id) await snapshots.restore(project, dareCheckpoint.id).catch(() => {});
        emit('rollback', 'done', 'The deterministic repair did not reach a verified running state, so the previous checkpoint was restored.');
      }
    } catch (err) {
      if (dareCheckpoint?.id) await snapshots.restore(project, dareCheckpoint.id).catch(() => {});
      emit('repair', 'failed', `Deterministic repair stopped safely: ${String(err.message || err).slice(0, 240)}`);
    }

    // Only count an AI attempt after deterministic repair is exhausted. The same
    // fingerprint is allowed once; a second identical click stops instead of
    // sending the same failing request back to AI.
    if (shouldBlockRepeatedAction(guard, problemFingerprint)) {
      const message = 'NEEDS_USER_ACTION: The same problem already had an automatic repair/AI attempt without a verified step forward. I stopped the loop. Provide new runtime evidence or change the failing condition before trying again.';
      emit('repair', 'failed', message);
      await projects.chat(project, message, 'assistant', { action: 'loop-guard', fingerprint: problemFingerprint });
      throw new Error(message);
    }
    await projects.saveMetadata(project, 'action-guard.json', nextRepeatState(guard, problemFingerprint));

    const relevant = await collectProjectContext(source);
    const attachContext = await attachmentContext(projects.projectDir(project));
    const attachList = await attachmentList(projects.projectDir(project));
    const security = await scanProject(source);
    const baselineDiagnosis = await diagnoseSource(source);
    const baselineStatic = await runStaticTests(source);
    const baselineNode = await runNodeTests(source, 45000);
    const baselineScore = failureScore(baselineStatic, baselineNode);
    const activity = await projects.readMetadata(project, 'activity.json', []);
    const recentJobs = jobs.list({ projectId: project.id, limit: 8 }).map((row) => {
      const full = jobs.get(row.id) || row;
      return { id: row.id, type: row.type, status: row.status, stage: row.stage, error: row.error, events: (full.events || []).slice(-6) };
    });
    const recentContext = `\nRECENT ACTIVITY (use as evidence; do not repeat a failed identical action):\n${JSON.stringify(Array.isArray(activity) ? activity.slice(-12) : [])}\nRECENT JOBS: ${JSON.stringify(recentJobs)}\n`;
    const networkContext = networkPreflight ? `\nBUILDER NETWORK PREFLIGHT:\n${JSON.stringify(networkPreflight)}\n` : '';
    const securityContext = security.findings?.length ? `\nSECURITY FINDINGS (treat as concrete repair requirements):\n${security.copy_for_ai}\n` : '';
    const r = await ai.completeJson({ task: 'DEBUGGING', system: SYSTEM, prompt: patchPrompt(project, '', relevant + recentContext + networkContext + securityContext + `\nATTACHMENTS (canonical project storage):\n${attachContext}\nATTACHMENT INDEX:\n${JSON.stringify(attachList)}`, feedback), projectId: project.id, images: await imageInputsFromAttachments(projects.projectDir(project)) });
    if (!r.json?.files?.length) throw new Error('AI did not propose a code change.');
    const declaredRisk = String(r.json.risk || 'medium').toLowerCase();
    if (declaredRisk !== 'low') throw new Error('NEEDS_USER_ACTION: AI marked this change as medium/high risk. No files were changed; review and confirm the requested change before applying it.');
    const patchCheckpoint = await applySafeAiPatch({ sourceDir: source, files: r.json.files, project, snapshots, reason: 'ai-improve' });
    await stampMadeBy(source, cfg);
    // First verify the proposed patch WITHOUT another mutating auto-fix. A later
    // repair must never hide a regression introduced by this step.
    const afterStatic = await runStaticTests(source);
    const afterNode = await runNodeTests(source, 45000);
    const afterScan = await scanProject(source);
    const afterScore = failureScore(afterStatic, afterNode);
    let runtime = null;
    const changedSecurity = afterScan.critical > security.critical || afterScan.warning > security.warning;
    if (afterScore > baselineScore || afterScan.critical > 0 || changedSecurity) {
      const latest = patchCheckpoint?.snapshot || snapshots.list(project.id)[0];
      if (latest?.id) {
        await snapshots.restore(project, latest.id).catch(() => {});
        emit('rollback', 'done', 'The change did not produce a verified step forward, so I restored the previous checkpoint.');
        const restored = await inspectOnly(project, emit);
        runtime = null;
        return { feedback, rootCause: r.json.root_cause || '', explanation: 'Change rolled back because verification regressed.', files: [], tested: { staticResult: restored.staticResult, nodeResult: restored.nodeResult, scan: restored.scan }, runtime };
      }
    }
    const tested = { staticResult: afterStatic, nodeResult: afterNode, scan: afterScan };
    if (afterStatic.status === 'passed' && afterNode.status !== 'failed' && afterScan.critical === 0) runtime = await runProject(projects.get(project.id), emit);
    if (runtime?.status === 'failed') {
      const latest = patchCheckpoint?.snapshot || snapshots.list(project.id)[0];
      if (latest?.id) {
        await snapshots.restore(project, latest.id).catch(() => {});
        emit('rollback', 'done', 'The live regression after this change was not verified, so I restored the previous checkpoint.');
        const restored = await inspectOnly(project, emit);
        runtime = null;
        tested.staticResult = restored.staticResult; tested.nodeResult = restored.nodeResult; tested.scan = restored.scan;
      }
    }
    const networkIssue = /\b(internet|offline|online|network|dns|proxy|gateway|browse|browsing|fetch|connection|kết nối|mạng|truy cập web)\b/i.test(feedback);
    if (networkIssue && runtime?.status === 'passed' && runtime?.internet?.ok !== true) {
      runtime.status = 'failed';
      runtime.error = 'Internet browsing is still not verified after the repair. The app page/health works, but the outbound Internet check failed or was unavailable.';
      runtime.brief = briefFail(runtime.error);
      emit('run', 'failed', runtime.error);
    }
    return { feedback, rootCause: r.json.root_cause || '', explanation: r.json.explanation || '', files: r.json.files.map((f) => f.path), tested, runtime };
  }

  function imageInputs(files) {
    let total = 0;
    const out = [];
    for (const f of (files || [])) {
      if (!/image\/(jpeg|png|gif|webp)/i.test(f?.mimetype || '') || !f.buffer || f.buffer.length > 20 * 1024 * 1024) continue;
      if (total + f.buffer.length > 40 * 1024 * 1024) break;
      total += f.buffer.length; out.push({ dataUrl: `data:${f.mimetype};base64,${f.buffer.toString('base64')}` });
      if (out.length >= 3) break;
    }
    return out;
  }

  async function applySafeAiPatch({ sourceDir, files, project, snapshots: snapshotStore, reason = 'ai-patch' }) {
    const proposed = Array.isArray(files) ? files.filter((f) => f && f.path && typeof f.content === 'string') : [];
    if (!proposed.length) throw new Error('AI returned no usable patch files.');
    if (proposed.length > 8) throw new Error('AI patch is too large for an automatic repair. I will not rewrite the project blindly.');
    const paths = new Set();
    for (const f of proposed) {
      const rel = String(f.path).replace(/\\/g, '/');
      if (paths.has(rel)) throw new Error(`AI patch contains the same file more than once: ${rel}`);
      paths.add(rel);
      if (Buffer.byteLength(f.content, 'utf8') > 1024 * 1024) throw new Error(`AI patch file is too large for a safe automatic change: ${rel}`);
      if (!rel || rel.startsWith('/') || rel.includes('..') || /^(?:data|workspace|projects)\//i.test(rel)) {
        throw new Error(`AI patch contains an unsafe path: ${rel}`);
      }
      if (/^(?:\.env(?:\.|$)|.*\/(?:\.env(?:\.|$)|id_rsa(?:\.|$)|private[_-]?key(?:\.|$)))/i.test(rel)) {
        throw new Error(`AI patch attempted to modify a protected file: ${rel}`);
      }
    }
    const snapshot = await snapshotStore.create(project, `before-${reason}`);
    const written = await writeGeneratedFiles(sourceDir, proposed);
    return { written, snapshot };
  }

  function failureScore(staticResult, nodeResult) {
    return (staticResult?.status === 'failed' ? 1 : 0) + (nodeResult?.status === 'failed' ? 1 : 0);
  }

  function repeatFingerprint(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/\d{2,}/g, '#')
      .replace(/https?:\/\/\S+/g, 'URL')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 900);
  }

  function mustProject(id) {
    const p = projects.get(id);
    if (!p) throw new Error('Project not found');
    return p;
  }

  async function runWithRepair(project, emit, userMessage) {
    emit('run', 'running', 'Starting a safe local preview…');
    let runtime = await runProject(project, emit);
    if (runtime.status === 'passed') return runtime;
    const crash = classifyLogs(`${runtime.error || ''}\n${runtime.logs || ''}`);
    const diagnosis = await diagnoseSource(projects.sourceDir(project.slug));
    if (crash?.code === 'registry_unauthorized' || crash?.code === 'github_workflow_permission') {
      const guide = crash.code === 'github_workflow_permission'
        ? 'GitHub Actions is read-only. Open GitHub → Repository → Settings → Actions → General → Workflow permissions → Read and write permissions → Save.'
        : 'The Docker image cannot be downloaded from GHCR. Check that the image name is correct and the GHCR package is public/pullable.';
      runtime.brief = [`RESULT: Not ready.`, `WHY: ${crash.title}`, `DONE: Identified an access problem outside the app source.`, `MISSING: ${guide}`, `NEXT: ${guide}`].join('\n');
      return runtime;
    }
    emit('repair', 'running', crash ? `Crash found: ${crash.title}` : 'Preview failed. Applying one automatic fix…');
    let dareCheckpoint = null;
    try {
      const history = await projects.readMetadata(project, 'dare-history.json', []);
      dareCheckpoint = await snapshots.create(project, 'before-dare-run-repair').catch(() => null);
      const dare = await runDare({
        sourceDir: projects.sourceDir(project.slug),
        logs: `${runtime.error || ''}\n${runtime.logs || ''}`,
        extra: crash || {},
        history: Array.isArray(history) ? history : [],
      });
      await projects.saveMetadata(project, 'dare-history.json', (dare.history || []).slice(-20));
      if (dare.ok) {
        emit('repair', 'done', formatDareReport(dare));
        emit('run', 'running', 'Retrying the preview after deterministic repair…');
        runtime = await runProject(project, emit);
        if (runtime.status === 'passed') return { ...runtime, dare };
        if (dareCheckpoint?.id) await snapshots.restore(project, dareCheckpoint.id).catch(() => {});
        emit('rollback', 'done', 'The deterministic repair did not produce a passing preview, so the previous checkpoint was restored before AI diagnosis.');
      } else if (dare.userAction) {
        runtime.brief = formatDareReport(dare);
        return runtime;
      }
    } catch {}
    const feedback = [
      userMessage,
      crash ? `${crash.title} ${crash.hint}` : 'Health check failed because the process died before listen or the UI files are missing.',
      diagnosis.findings.map((f) => f.title).join('; '),
      runtime.error,
    ].filter(Boolean).join('\n');
    try {
      await improveProject(project, feedback, emit);
      emit('run', 'running', 'Retrying the preview after the fix…');
      runtime = await runProject(project, emit);
    } catch (err) {
      runtime = { ...runtime, repairError: err.message };
    }
    return runtime;
  }

  return { review };
}

function failSummary(staticResult) {
  return (staticResult.checks || [])
    .filter((c) => !c.ok)
    .map((c) => `${c.name} failed`)
    .join('\n');
}

async function collectRelevant(source) {
  const names = ['package.json', 'src/server.js', 'Dockerfile', 'tests/app.test.js'];
  const chunks = [];
  const existing = new Set(await listFiles(source));
  for (const n of names) {
    if (!existing.has(n)) continue;
    const text = await fs.readFile(path.join(source, n), 'utf8').catch(() => '');
    chunks.push(`--- ${n} ---\n${clampText(text, 2500)}`);
  }
  return chunks.join('\n\n');
}

function formatUserBrief({ action, runtime, diagnosis, reply, next, language = 'English', reports = [] }) {
  const templates = {
    English: { running: 'App is running.', failed: 'App did not stay up.', finished: 'Action finished.', none: 'none.', needRun: 'a passing Run.', image: 'safe preview started, health check and browser test passed.' },
    Vietnamese: { running: 'Ứng dụng đang chạy.', failed: 'Ứng dụng chưa chạy ổn định.', finished: 'Đã hoàn tất thao tác.', none: 'không có.', needRun: 'một lần Run thành công.', image: 'đã build image, khởi động container và kiểm tra /health thành công.' },
    Chinese: { running: '应用正在运行。', failed: '应用未能稳定运行。', finished: '操作已完成。', none: '无。', needRun: '一次成功的运行。', image: '镜像已构建，容器已启动，/health 检查通过。' },
    Japanese: { running: 'アプリは実行中です。', failed: 'アプリは安定して起動できませんでした。', finished: '操作が完了しました。', none: 'ありません。', needRun: '成功したRunが必要です。', image: 'イメージをビルドし、コンテナを起動して /health を確認しました。' },
    Korean: { running: '앱이 실행 중입니다.', failed: '앱이 안정적으로 실행되지 않았습니다.', finished: '작업이 완료되었습니다.', none: '없습니다.', needRun: '성공한 Run이 필요합니다.', image: '이미지를 빌드하고 컨테이너를 시작했으며 /health 검사를 통과했습니다.' },
    Spanish: { running: 'La aplicación está en ejecución.', failed: 'La aplicación no se mantuvo activa.', finished: 'La acción ha terminado.', none: 'ninguno.', needRun: 'una ejecución correcta.', image: 'la imagen se creó, el contenedor inició y /health pasó.' },
    French: { running: 'L’application est en cours d’exécution.', failed: 'L’application ne reste pas active.', finished: 'L’action est terminée.', none: 'aucun.', needRun: 'une exécution réussie.', image: 'l’image a été construite, le conteneur démarré et /health validé.' },
  };
  const t = templates[language] || templates.English;
  const failedReports = Array.isArray(reports) ? reports.filter((s) => s.status === 'failed' || s.status === 'blocked') : [];
  const result = failedReports.length
    ? t.failed
    : runtime?.status === 'passed'
      ? t.running
      : runtime?.error ? t.failed : action === 'reply' ? (reply || t.finished) : t.finished;
  const done = failedReports.length
    ? reports.filter((s) => s.status === 'done').map((s) => s.action).join(', ') || action
    : runtime?.status === 'passed' ? t.image : action;
  const missing = failedReports.length
    ? failedReports.map((s) => `${s.action}: ${String(s.error || 'not completed').slice(0, 180)}`).join('; ')
    : diagnosis?.findings?.length ? diagnosis.findings.map((f) => f.title).join('; ') : (runtime?.status === 'passed' ? t.none : (classifyLogs(runtime?.error || runtime?.logs || '')?.title || t.needRun));
  const card = describeFailure({ error: runtime?.error || '', logs: runtime?.logs || '', findings: diagnosis?.findings || [], action });
  const why = runtime?.status === 'failed' ? card.what : (runtime?.error ? String(runtime.error).split('\n')[0].slice(0, 220) : '');
  const extra = reply && !/RESULT:/i.test(reply) ? reply : '';
  const reportLines = Array.isArray(reports) && reports.length
    ? reports.map((s) => `${s.status === 'done' ? '✅' : '⚠️'} ${s.action}: ${String(s.goal || '').slice(0, 80)}${s.error ? ` (${s.error})` : ''}`).join('\n')
    : '';
  const failBlock = runtime?.status === 'failed' ? [`FIX: ${card.fix}`, `COPY_FOR_AI:\n${card.copy}`] : [];
  return [`RESULT: ${result}`, why ? `WHY: ${why}` : '', `DONE: ${done}`, `MISSING: ${missing}`, `NEXT: ${next}`, ...failBlock, reportLines, extra].filter(Boolean).join('\n');
}

function briefRun(runtime) {
  return [
    `RESULT: App is running.`,
    `TEST LINK: ${runtime.previewPath || runtime.url}`,
    `DONE: Safe preview started; health and browser checks passed.${runtime.internet?.ok === true ? ' Outbound Internet was also verified.' : ' Outbound Internet is not verified by this test.'}`,
    `MISSING: none for a test run.`,
    `NEXT: Open the test link, then tell me what to change. Tap Publish when you are happy.`,
  ].join('\n');
}

function briefFail(reason) {
  const card = describeFailure({ error: reason || '' });
  return [
    `RESULT: Not ready.`,
    `WHY: ${card.what}`,
    `FIX: ${card.fix}`,
    `MISSING: a passing run.`,
    `NEXT: Use the FIX above, or send COPY_FOR_AI to chat.`,
    `COPY_FOR_AI:\n${card.copy}`,
  ].join('\n');
}

function normalizeQuestions(questions) {
  return (Array.isArray(questions) ? questions : []).slice(0, 3).map((q) => {
    if (typeof q === 'string') return { question: q, options: [], required: true };
    return { question: String(q?.question || ''), options: Array.isArray(q?.options) ? q.options.slice(0, 4).map(String) : [], required: q?.required !== false };
  }).filter((q) => q.question);
}

async function checkBuilderInternet() {
  const targets = ['example.com', 'www.google.com', 'cloudflare.com'];
  const dnsResults = [];
  const httpsResults = [];
  for (const host of targets) {
    try {
      const addresses = await Promise.race([
        dns.lookup(host, { all: true }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('DNS timeout')), 5000)),
      ]);
      dnsResults.push({ host, ok: Array.isArray(addresses) && addresses.length > 0, addresses: (addresses || []).map((x) => x.address) });
    } catch (err) { dnsResults.push({ host, ok: false, error: String(err?.code || err?.message || err) }); }
    try {
      const result = await new Promise((resolve) => {
        const req = https.request(`https://${host}/`, { method: 'HEAD', timeout: 7000, headers: { 'User-Agent': 'Pi-App-Factory-Network-Preflight/1.0' } }, (res) => { res.resume(); resolve({ ok: res.statusCode > 0, status: res.statusCode }); });
        req.on('timeout', () => req.destroy(new Error('HTTPS timeout')));
        req.on('error', (err) => resolve({ ok: false, error: String(err?.code || err?.message || err) }));
        req.end();
      });
      httpsResults.push({ host, ...result });
    } catch (err) { httpsResults.push({ host, ok: false, error: String(err?.message || err) }); }
  }
  const dnsOk = dnsResults.filter((x) => x.ok).length;
  const httpsOk = httpsResults.filter((x) => x.ok).length;
  const ok = httpsOk > 0;
  return {
    ok,
    targets,
    dnsOk,
    httpsOk,
    dns: dnsResults,
    https: httpsResults,
    summary: ok ? `Builder outbound HTTPS works for ${httpsOk}/${targets.length} test hosts.` : (dnsOk ? 'Builder DNS works, but outbound HTTPS is blocked.' : 'Builder DNS/network access is unavailable.'),
    remediation: ok ? 'Environment network is available. Continue with app-specific proxy/gateway diagnosis.' : 'Do not rewrite the app proxy yet. Fix Builder/Sandbox DNS or outbound network access first.'
  };
}

function improvePrompt(project, feedback, context) {
  return `Improve this existing application from the user's feedback.

Project: ${project.name}
Idea: ${project.idea}
User feedback: ${feedback}

Relevant files:
${context}

NETWORK DEBUGGING CONTRACT:
- If feedback mentions Internet, offline, proxy, gateway, DNS, fetch, browsing, or connection: diagnose before editing.
- If the latest Sandbox Benchmark says DNS_UNAVAILABLE or DNS_OK_BUT_HTTPS_BLOCKED, do not modify product proxy code; report the sandbox/environment blocker.
- If Sandbox Internet is available, inspect the actual app gateway/proxy, DNS lookup, HTTPS request, redirects, timeouts, response status, CORS/CSP, and browser-facing routing.
- Do not merely describe a fix: when the root cause is in source code, return the smallest concrete file patch.
- Re-test the real browsing flow after patching.
- Never call a passing /health or page-load check proof that Internet browsing works.

Return JSON with full file contents for every changed file:
{
  "root_cause": "",
  "files": [{"path":"","content":"full file content"}],
  "explanation": "short beginner-friendly explanation"
}`;
}

async function collectProjectContext(source) {
  const allFiles = await listFiles(source);
  const preferred = ['package.json', 'Dockerfile', 'docker-compose.yml', 'config_options.yml', '.github/workflows/docker.yml', 'README.md', 'INSTALL.md', 'src/server.js', 'server.js', 'app.js', 'src/app.js', 'src/proxy.js', 'src/gateway.js', 'src/routes.js', 'public/index.html', 'public/game.js', 'public/app.js', 'public/browser.js'];
  const names = [...preferred, ...allFiles.filter((f) => /^(src|server|public|tests)\//.test(f) && /\.(js|mjs|cjs|ts|tsx|jsx|html|css|json|yml|yaml)$/.test(f)).slice(0, 24)];
  const unique = [...new Set(names)].filter((name) => allFiles.includes(name));
  const chunks = [
    `--- BUILDER TOOLBOX ---\ninspect files · static tests · Node tests · security scan · native preview · Container Sandbox · runtime logs · GitHub publish · Actions diagnostics · GHCR verify · SoloHost validator · checkpoint · rollback`,
    `--- FILE INVENTORY (${allFiles.length}) ---\n${allFiles.slice(0, 120).join('\n')}`,
  ];
  let total = chunks.join('\n\n').length;
  for (const name of unique.slice(0, 36)) {
    if (total > 30000) break;
    const text = await fs.readFile(path.join(source, name), 'utf8').catch(() => '');
    const part = `--- ${name} ---\n${clampText(text, name === 'README.md' || name.endsWith('.css') ? 2200 : 4200)}`;
    chunks.push(part);
    total += part.length;
  }
  return clampText(chunks.join('\n\n'), 32000);
}

function friendlyAiError(err) {
  const m = String(err?.message || err);
  const providers = Array.isArray(err?.providerErrors) ? err.providerErrors.map((x) => String(x).replace(/\s+/g, ' ').slice(0, 260)) : [];
  const detail = providers.join(' | ');
  if (/No AI provider is configured|API key is not configured/i.test(m)) return 'No active AI key is available. Builder can use DeepSeek or Gemini; save a valid key in Settings.';
  if (/HTTP 401|HTTP 403|bad credentials|invalid api key/i.test(m)) return `AI authentication failed. ${detail || 'The selected key was rejected.'} Check the provider key, then Save Settings.`;
  if (/HTTP 404|model.*not found|invalid.*model/i.test(m)) return `AI model is unavailable. ${detail || 'Builder will rotate to a supported model automatically.'} Save Settings to reset model selection.`;
  if (/HTTP 429|quota|rate limit|resource exhausted/i.test(m)) return `AI quota/rate limit was reached. ${detail || 'The request was throttled.'} Builder will try another configured provider when available.`;
  if (/HTTP 402|Insufficient Balance|billing/i.test(m)) return `The AI provider requires available credit. ${detail || 'Use another configured provider/key.'}`;
  if (/timeout|timed out|fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|network/i.test(m)) return `AI connection failed. ${detail || 'No files were changed.'} Builder will retry transient failures and switch provider when possible.`;
  if (/AI_BAD_JSON|invalid JSON|FORMAT_ERROR/i.test(m)) return 'The AI returned an invalid work format. No files were changed; Builder will retry with the strict JSON contract.';
  return detail
    ? `AI could not complete this step. No files were changed. Details: ${detail}`
    : 'AI could not complete this step. No files were changed. Save a valid provider key/model, then retry.';
}

function gateAction(action, { files = [], runtime = {}, githubConfigured = false, imageRef = '' } = {}) {
  const hasFiles = Array.isArray(files) && files.length > 0;
  const ran = runtime.status === 'passed' && runtime.health === true;
  if (action === 'export' && imageRef) {
    return { action: 'export', lock: '' };
  }
  if ((action === 'run' || action === 'analyze') && !hasFiles) {
    return { action: 'build', lock: 'No app files yet. I will Build first, then you can Run.' };
  }
  if (action === 'improve' && !hasFiles) {
    return { action: 'build', lock: 'There is nothing to improve yet. Describe the app so I can Build it first.' };
  }
  if (action === 'export' && !hasFiles) {
    return { action: 'build', lock: 'There is no project to zip yet. Build the app first.' };
  }
  if (action === 'publish' && !hasFiles) {
    return { action: 'build', lock: 'Publish is locked. Build the app first, then Run, then Publish.' };
  }
  if (action === 'publish' && !ran) {
    return { action: 'run', lock: 'Publish is locked until the preview runs. I will Run the app first.' };
  }
  if (action === 'publish' && !githubConfigured) {
    return { action: 'reply', lock: 'Publish needs a GitHub username and token in Settings. Add them, then tap Publish.' };
  }
  return { action, lock: '' };
}

function formatProjectDiagnosis(report) {
  const lines = ['🩺 PROJECT DIAGNOSIS', `Status: ${report.currentStatus || 'unknown'}`, `Confidence: ${report.confidence}`, `Root cause: ${report.rootCause}`];
  if (report.fingerprint && report.fingerprint !== 'NONE') lines.push(`Fingerprint: ${report.fingerprint}`);
  if (report.problems?.length) lines.push('', ...report.problems.slice(0, 4).map((p) => `⚠ ${p.id}: ${p.recommendation || p.evidence}`));
  if (report.previousFailedAttempts?.length) lines.push('', '⛔ Repeated ineffective repair detected. I will not repeat the same fix without new evidence.');
  lines.push('', `Next: ${report.recommendation}`, '', 'Verification: Build → Start → Health → Functional → Preview');
  if (report.ai?.unavailable) lines.push('', 'AI enhancement unavailable; deterministic evidence report is still available.');
  return lines.join('\n');
}

function formatAdvisor(report) {
  const o = report.overview || {};
  const lines = [
    '🧭 AI ADVISOR',
    `Apps analyzed: ${o.appsAnalyzed || 0}`,
    `Failed jobs: ${o.failedJobs || 0}`,
    'Advisor does not edit apps or Builder.',
  ];
  for (const row of (report.patterns || []).slice(0, 4)) lines.push('', `Pattern: ${row.what}`, `Why: ${row.why || ''}`, `Recommendation: ${row.recommendation}`);
  for (const row of (report.appImprovements || []).slice(0, 4)) lines.push('', `App: ${row.app}`, `What: ${row.what}`, `Recommendation: ${row.recommendation}`);
  if (!report.patterns?.length && !report.appImprovements?.length) lines.push('', 'No recurring problems in the selected scope.');
  return lines.join('\n');
}

function formatUserDiagnosis(report) {
  return [
    '⚠️ Problem detected',
    '🔎 Diagnosis complete',
    `Cause: ${report.rootCause}`,
    `Confidence: ${report.confidence}`,
    report.evidenceLedger?.conclusion ? `Evidence: ${report.evidenceLedger.conclusion}` : '',
    `Next: ${report.recommendation}`,
    report.previousFailedAttempts?.length ? 'The previous repair will not be repeated automatically.' : '',
  ].filter(Boolean).join('\n');
}
