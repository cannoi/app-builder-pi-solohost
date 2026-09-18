import path from 'node:path';
import { SYSTEM, ideaPrompt, planPrompt, codePrompt, patchPrompt, reviewPrompt, chatPrompt, builderChatPrompt, descriptionPrompt } from '../ai/prompts.js';
import { localAnalysis, localPlan, writeGeneratedFiles, scaffoldFromTemplate, writeGithubWorkflow } from '../projects/generator.js';
import { importZipBuffer } from '../projects/importer.js';
import { runStaticTests, runNodeTests } from '../testing/engine.js';
import { scanProject } from '../security/scanner.js';
import { clampText } from '../utils/validate.js';
import { listFiles } from '../utils/fsx.js';
import fs from 'node:fs/promises';
import { saveAttachment, attachmentContext, attachmentList, imageInputsFromAttachments } from '../projects/attachments.js';
import { writeSoloHostPackage } from '../release/solohost.js';
import { inferAction, classifyLogs, diagnoseSource, nextStep, guideCard, isHostDockerCommand, isNpmOnEmptyRisk, splitUserSteps } from '../scripts/ops.js';
import { stampMadeBy } from '../projects/badge.js';
import { createProjectZip } from '../projects/exporter.js';
import { gcDocker } from '../docker/cleanup.js';
import { detectUserLanguage, languageInstruction, languageInstructionFor } from '../ai/language.js';
import { publishToGitHub } from '../github/publish.js';

export function registerPipeline(app) {
  const { jobs, ai, projects, snapshots, runner, sandbox, github, releases, cfg, log } = app;

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

    if (job.payload.autoBuild && analysis.questions.length && !job.payload.demo) {
      projects.setStatus(project, 'WAITING_INPUT');
      await projects.chat(project, 'I need a few quick choices before I build this.', 'assistant', { questions: analysis.questions, fixedTemplate: true });
      emit('questions', 'done', 'I need a few quick choices before I build this.');
      return { projectId: project.id, analysis, plan, needsInput: true, questions: analysis.questions };
    }

    projects.setStatus(project, 'READY_TO_BUILD');
    if (job.payload.autoBuild) {
      emit('generate', 'running', 'Writing the first version…');
      await generateCode({ project: projects.get(project.id), analysis, plan, emit, allowFallback: Boolean(job.payload.demo) });
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
    return generateCode({ project: projects.get(project.id), analysis, plan: nextPlan, emit, allowFallback: false });
  });

  jobs.on('build', async (job, { emit }) => {
    const project = mustProject(job.payload.projectId);
    const analysis = await projects.readMetadata(project, 'requirements.json', {});
    const plan = await projects.readMetadata(project, 'architecture.json', {});
    return generateCode({ project, analysis, plan, emit, allowFallback: false });
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
    await projects.saveMetadata(project, 'test-plan.json', { ...tests, preview: result, e2e: result.e2e || null });
    if (result.status === 'passed') {
      projects.setStatus(project, 'WAITING_APPROVAL');
      emit('run', 'done', '✓ Preview started and browser check passed.');
    } else {
      projects.setStatus(project, 'FAILED');
      const message = result.error || 'The app could not start or pass browser testing.';
      emit('run', 'failed', message);
      // Fix: previously this handler returned normally even when the preview failed,
      // which made JobQueue mark the job "done" and hid the error + link from the UI.
      // Throwing here makes JobQueue mark it "failed" so the real error reaches the user.
      throw new Error(message);
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
    const source = projects.sourceDir(project.slug);
    const relevant = await collectProjectContext(source);
    emit('ai', 'running', 'AI is turning your feedback into a change…');
    const r = await ai.completeJson({ task: 'DEBUGGING', system: SYSTEM, prompt: improvePrompt(project, feedback, relevant), projectId: project.id });
    if (!r.json?.files?.length) throw new Error('AI did not propose a code change.');
    await snapshots.create(project, 'before-improve');
    emit('patch', 'running', 'Applying the improvement…');
    await writeGeneratedFiles(source, r.json.files);
    const tested = await testAndMaybeFix(projects.get(project.id), emit);
    if (tested.staticResult?.status === 'passed' && tested.nodeResult?.status !== 'failed') {
      emit('run', 'running', 'Refreshing the safe preview…');
      const runtime = await runner.runApp({ sourcePath: source, projectSlug: project.slug, timeout: cfg.limits.sandboxTimeoutSec, keepRunning: true });
      await projects.saveMetadata(project, 'runtime.json', { ...runtime, image: null, updatedAt: new Date().toISOString() });
    }
    return { feedback, rootCause: r.json.root_cause || '', explanation: r.json.explanation || '', files: r.json.files.map((f) => f.path), tested };
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
    const security = await projects.readMetadata(project, 'security.json', {});
    const runtime = await projects.readMetadata(project, 'runtime.json', {});
    if (payload.approved !== true && payload.confirm !== true) throw new Error('Release blocked: approve the tested app first.');
    if (security.critical > 0) throw new Error('Release blocked: a security issue must be fixed first.');
    if (runtime.status !== 'passed' || runtime.health !== true) throw new Error('Release blocked: run the app successfully before publishing. Tap Run first.');
    if (tests.nodeResult?.status === 'failed') throw new Error('Release blocked: tests failed. Tap Improve, then Run.');
    const source = projects.sourceDir(project.slug);
    await stampMadeBy(source, cfg);
    await writeGithubWorkflow(source, project);
    const quality = await review(project);
    let aiDescription = '';
    try {
      const desc = await ai.completeJson({ task: 'DESCRIPTION', system: SYSTEM, prompt: descriptionPrompt(project), projectId: project.id });
      aiDescription = String(desc.json?.description || '').trim();
    } catch { /* deterministic fallback below */ }
    const notes = await releases.prepareNotes(project, source, quality);
    emit('package', 'running', 'Creating the SoloHost package…');
    let githubUrl = null;
    let githubPublish = null;
    if (github.configured() && payload.push !== false) {
      emit('github', 'running', 'Publishing source…');
      githubPublish = await publishToGitHub({
        github,
        project,
        sourceDir: source,
        version: notes.version,
        emit,
        runtimeOk: runtime.health === true && runtime.status === 'passed',
        repoName: payload.repoName || project.slug,
        existingAction: payload.existingAction || 'confirm',
      });
      githubUrl = githubPublish.ok && githubPublish.verified ? githubPublish.url : null;
      if (githubPublish.code === 'REPO_EXISTS') {
        return {
          status: 'needs_repository_choice', githubUrl: githubPublish.url || null, githubPublish,
          installReady: false, checklist: ['✓ Build', '✓ Test', '• GitHub', '• GHCR', '• SoloHost'],
          repoChoice: true, choices: githubPublish.choices || [], guide: { step: 3, title: 'Choose what to do with the existing repository', action: 'publish', label: '🚀 Publish', detail: 'The repository already exists. Choose Overwrite to replace its files, or Create new repository to keep it unchanged.' },
          brief: `RESULT: GitHub needs your choice.\nWHY: The repository ${githubPublish.owner}/${githubPublish.repo} already exists.\nDONE: The app passed the pre-publish checks.\nMISSING: Your choice — overwrite the existing repository or create a new one.\nNEXT: Choose one option below.`,
          next: 'Choose Overwrite or Create new repository.',
        };
      }
      if (!githubPublish.ok) {
        const zipFail = await createProjectZip({ sourceDir: source, outputDir: path.join(projects.projectDir(project), 'artifacts'), slug: project.slug, kind: 'project' }).catch(() => null);
        return {
          status: 'blocked',
          githubUrl: null,
          githubPublish,
          installReady: false,
          checklist: ['✓ Build', '✓ Test', '✗ GitHub', '• GHCR', '• SoloHost'],
          downloads: [
            ...(zipFail ? [{ kind: 'project', filename: zipFail.filename, url: `/api/projects/${project.id}/download?kind=project` }] : []),
            { kind: 'github-fallback', filename: 'GitHub-ZIP-Publisher-v2.6.ps1', url: `/api/projects/${project.id}/github-fallback` },
          ],
          fallback: { ...(githubPublish.fallback || {}), scriptUrl: `/api/projects/${project.id}/github-fallback`, scriptFilename: 'GitHub-ZIP-Publisher-v2.6.ps1' },
          brief: [githubPublish.error, githubPublish.fix].filter(Boolean).join('\n'),
          next: 'GitHub source was not verified. Tap Download Project and upload the files on github.com, or fix access and tap Publish once.',
        };
      }
    } else {
      githubPublish = { ok: false, code: 'GITHUB_NOT_CONFIGURED', error: 'GitHub authorization is required.', fallback: { action: 'download', label: 'Download Project' } };
    }
    const owner = githubPublish?.owner || cfg.github.owner || 'YOUR_GITHUB';
    const registryImage = `ghcr.io/${owner}/${project.slug}:${notes.version}`.toLowerCase();
    let pushedImage = { status: 'github-actions', reason: 'The repository workflow builds and publishes the GHCR image. App Builder does not access the host Docker daemon.' };
    let imageVerification = { ok: false };
    if (githubUrl) {
      emit('docker-publish', 'running', 'Waiting for GitHub Actions to publish GHCR…');
      const verifyDeadline = Date.now() + 120000;
      while (Date.now() < verifyDeadline) {
        imageVerification = await github.verifyContainerImage(`${owner}/${project.slug}`, notes.version).catch((err) => ({ ok: false, error: err.message }));
        if (imageVerification.ok) break;
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
      if (imageVerification.ok) {
        try { await github.setContainerPublic(`${owner}/${project.slug}`); } catch {}
        await github.createRelease(project.slug, notes.version, notes.notes).catch((err) => log.warn('GitHub release notes failed', { error: String(err.message || err).replace(/ghp_[A-Za-z0-9]+/g, 'ghp_***') }));
      }
    }
    const packageInfo = await releases.prepareSoloHost(project, source, registryImage, aiDescription);
    const validation = await releases.validateSoloHost(source);
    const zip = await createProjectZip({ sourceDir: source, outputDir: path.join(projects.projectDir(project), 'artifacts'), slug: project.slug, kind: 'solohost' }).catch(() => null);
    const imageOk = Boolean(imageVerification.ok);
    const installReady = Boolean(validation?.ok !== false && runtime.health && githubUrl && imageOk);
    const status = installReady ? 'released' : (githubUrl ? 'github_published' : 'blocked');
    const rec = releases.record(project, { version: notes.version, notes: notes.notes, githubUrl, status });
    projects.setStatus(project, installReady ? 'RELEASED' : 'WAITING_APPROVAL');
    const checklist = [
      '✓ Build',
      runtime.health ? '✓ Test' : '• Test',
      githubUrl ? '✓ GitHub' : '✗ GitHub',
      imageOk ? '✓ GHCR' : '✗ GHCR',
      installReady ? '✓ SoloHost' : '• SoloHost',
    ];
    const ghcrNote = imageOk
      ? `GHCR image confirmed: ${registryImage}`
      : `GitHub source is ready, but ${registryImage} is not confirmed yet. The repository workflow may still be building it. Do not install on SoloHost until this exact image tag exists. If the workflow fails, use the Windows GitHub Publisher fallback to verify/upload and diagnose the image.`;
    if (installReady) emit('release', 'done', 'Complete');
    else if (githubUrl) emit('release', 'done', ghcrNote);
    return {
      status, release: rec, quality, githubUrl, githubPublish, installReady, checklist,
      image: registryImage, imageVerification, soloHostPackage: packageInfo, validation, imageOk,
      downloads: [
        zip ? { kind: 'solohost', filename: zip.filename, url: `/api/projects/${project.id}/download?kind=solohost` } : null,
        { kind: 'project', filename: `${project.slug}-source.zip`, url: `/api/projects/${project.id}/download?kind=project` },
        { kind: 'github-fallback', filename: 'GitHub-ZIP-Publisher-v2.6.ps1', url: `/api/projects/${project.id}/github-fallback` },
      ].filter(Boolean),
      fallback: githubPublish?.fallback || null,
      missing: installReady ? [] : [imageOk ? null : 'GHCR image is not confirmed yet.'].filter(Boolean),
      next: installReady
        ? 'GitHub and GHCR are verified. Use the SoloHost files to install.'
        : (githubUrl ? ghcrNote : 'Connect GitHub in Settings, then tap Publish.'),
      install: githubPublish?.install || null,
      brief: githubUrl
        ? [`GitHub: ${githubUrl}`, ghcrNote, githubPublish?.install].filter(Boolean).join('\n')
        : [githubPublish?.error, githubPublish?.fix].filter(Boolean).join('\n'),
    };
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
    const handoff = await projects.readMetadata(project, 'handoff.json', {});
    const context = await collectProjectContext(source);
    const attachContext = await attachmentContext(projects.projectDir(project));
    emit('ai', 'running', 'AI is deciding the next best step…');
    let r = { json: { action: inferAction(message) || 'reply', reply: '', commands: [] } };
    try {
      r = await ai.completeJson({
        task: 'USER_CHAT',
        system: SYSTEM,
        prompt: builderChatPrompt(project, message, `${languageInstruction(message)}\nHANDOFF:\n${JSON.stringify(handoff)}\nHISTORY:\n${history}\nDIAGNOSIS:\n${JSON.stringify(diagnosis)}\nRUNTIME:\n${JSON.stringify({ status: runtimeNow.status, error: runtimeNow.error, previewPath: runtimeNow.previewPath })}\n${context}\n${attachContext}`, await attachmentList(projects.projectDir(project))),
        projectId: project.id,
        images: [...imageInputs(incomingFiles), ...(await imageInputsFromAttachments(projects.projectDir(project)))],
      });
    } catch (err) {
      emit('ai', 'failed', friendlyAiError(err));
    }
    let action = String(r.json?.action || inferAction(message) || 'reply');
    if (action === 'reply') {
      const inferred = inferAction(message);
      if (inferred && inferred !== 'reply') action = inferred;
    }
    const gated = gateAction(action, { files: diagnosis.files, runtime: runtimeNow, githubConfigured: github.configured() });
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
    if (action === 'question' && Array.isArray(r.json.questions) && r.json.questions.length) {
      await projects.saveMetadata(project, 'chat-question.json', { questions: r.json.questions });
      projects.setStatus(project, 'WAITING_INPUT');
      payload.questions = r.json.questions;
    } else {
      for (const step of planned) {
        let stepAction = step.action;
        const gatedStep = gateAction(stepAction, { files: diagnosis.files, runtime: runtimeNow, githubConfigured: github.configured() });
        if (gatedStep.lock) stepAction = gatedStep.action;
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
            emit('analyze', 'running', 'Checking files, crash logs, and security…');
            payload.tested = await testAndMaybeFix(project, emit);
            payload.diagnosis = await diagnoseSource(source);
            if (runtimeNow.logs) payload.crash = classifyLogs(runtimeNow.logs || runtimeNow.error || '');
          } else if (stepAction === 'export') {
            const kind = /install|solohost|config|cài đặt|solo\s*host/i.test(step.goal) ? 'solohost' : 'project';
            const artifact = await createProjectZip({ sourceDir: projects.sourceDir(project.slug), outputDir: path.join(projects.projectDir(project), 'artifacts'), slug: project.slug, kind });
            payload.downloads = [{ kind, filename: artifact.filename, url: `/api/projects/${project.id}/download?kind=${kind}` }];
          } else if (stepAction === 'publish') {
            emit('release', 'running', 'Publishing the app now…');
            payload.result = await runRelease(project, { approved: true, confirm: true, push: true, existingAction: 'confirm' }, emit);
            payload.publish_ready = payload.result?.status === 'released' || payload.result?.status === 'packaged';
          }
          payload.reports.push({ action: stepAction, status: 'done', goal: step.goal });
        } catch (err) {
          payload.reports.push({ action: stepAction, status: 'failed', goal: step.goal, error: String(err.message || err).slice(0, 240) });
          emit('improve', 'failed', `Step failed, continuing other safe steps: ${String(err.message || err).slice(0, 160)}`);
        }
      }
    }
    const latestRuntime = payload.runtime || payload.result?.runtime || await projects.readMetadata(project, 'runtime.json', {});
    if (action !== 'run') {
      await gcDocker({ keepImage: null, keepContainer: null, log }).catch(() => {});
    } else {
      await gcDocker({ keepImage: latestRuntime.image || null, keepContainer: latestRuntime.status === 'passed' ? latestRuntime.container : null, log }).catch(() => {});
    }
    payload.guide = guideCard({ runtime: latestRuntime, findings: diagnosis.findings, action, publishReady: payload.publish_ready });
    payload.next = payload.guide.detail;
    payload.brief = formatUserBrief({ action, runtime: latestRuntime, diagnosis, reply, next: payload.next, language: userLanguage, reports: payload.reports });
    await gcDocker({ keepImage: latestRuntime.image || null, keepContainer: latestRuntime.status === 'passed' ? latestRuntime.container : null, log }).catch(() => {});
    await projects.chat(project, payload.brief, 'assistant', { action, next: payload.next });
    await projects.saveMetadata(project, 'handoff.json', {
      updatedAt: new Date().toISOString(),
      userLanguage,
      lastUserMessage: message,
      lastAction: action,
      lastBrief: payload.brief,
      next: payload.next,
      runtime: { status: latestRuntime.status, previewPath: latestRuntime.previewPath, error: latestRuntime.error },
      files: diagnosis.files.slice(0, 40),
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
    const stack = await importZipBuffer(buf, dest);
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
    await writeGeneratedFiles(projects.sourceDir(project.slug), files);
    await stampMadeBy(projects.sourceDir(project.slug), cfg);
    await writeGithubWorkflow(projects.sourceDir(project.slug), project);
    return testAndMaybeFix(projects.get(project.id), emit);
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
    while (
      (staticResult.status === 'failed' || nodeResult.status === 'failed')
      && attempts < cfg.limits.maxAutoFixes
    ) {
      attempts += 1;
      emit('repair', 'running', `Trying a safe fix (${attempts}/${cfg.limits.maxAutoFixes})…`);
      projects.setStatus(project, 'REPAIRING');
      await snapshots.create(project, `before-fix-${attempts}`);
      const errText = [failSummary(staticResult), nodeResult.error].filter(Boolean).join('\n');
      const relevant = await collectRelevant(source);
      try {
        const r = await ai.completeJson({
          task: 'DEBUGGING',
          system: SYSTEM,
          prompt: patchPrompt(project, errText, relevant),
          projectId: project.id,
        });
        if (r.json?.files?.length) await writeGeneratedFiles(source, r.json.files);
      } catch (err) {
        emit('repair', 'failed', friendlyAiError(err));
        break;
      }
      staticResult = await runStaticTests(source);
      nodeResult = await runNodeTests(source, 45000);
    }
    emit('security', 'running', 'Looking for secrets and unsafe settings…');
    const scan = await scanProject(source);
    await projects.saveMetadata(project, 'security.json', scan);
    emit('preview', 'running', 'Starting a safe preview without host Docker access…');
    const dockerBuild = await runner.run({ sourcePath: source, projectSlug: project.slug, timeout: cfg.limits.sandboxTimeoutSec });
    const imageFile = null;
    await projects.saveMetadata(project, 'test-plan.json', { staticResult, nodeResult, scan, preview: dockerBuild, dockerBuild, e2e: dockerBuild.e2e || null, imageFile });
    const ok = staticResult.status === 'passed' && nodeResult.status !== 'failed' && scan.critical === 0 && dockerBuild.status === 'passed';
    projects.setStatus(project, ok ? 'WAITING_APPROVAL' : 'FAILED');
    if (ok) emit('test', 'done', '✓ Source checks, security, preview and Playwright E2E passed.');
    return { staticResult, nodeResult, scan, dockerBuild, e2e: dockerBuild.e2e || null, imageFile, autoFixes: attempts, next: ok ? 'Open the preview with Run, Improve if needed, or Publish when ready.' : 'Fix the blocking issue shown above, then Build again.' };
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
    await projects.saveMetadata(project, 'runtime.json', { ...runtime, image: null, updatedAt: new Date().toISOString() });
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

  async function improveProject(project, feedback, emit) {
    const source = projects.sourceDir(project.slug);
    const relevant = await collectProjectContext(source);
    const r = await ai.completeJson({ task: 'DEBUGGING', system: SYSTEM, prompt: patchPrompt(project, '', relevant, feedback), projectId: project.id, images: [] });
    if (!r.json?.files?.length) throw new Error('AI did not propose a code change.');
    await snapshots.create(project, 'before-improve');
    await writeGeneratedFiles(source, r.json.files);
    await stampMadeBy(source, cfg);
    const tested = await testAndMaybeFix(projects.get(project.id), emit);
    let runtime = null;
    if (tested.staticResult?.status === 'passed' && tested.nodeResult?.status !== 'failed' && tested.scan?.critical === 0) runtime = await runProject(projects.get(project.id), emit);
    return { feedback, explanation: r.json.explanation || '', files: r.json.files.map((f) => f.path), tested, runtime };
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
  const result = runtime?.status === 'passed'
    ? t.running
    : runtime?.error ? t.failed : action === 'reply' ? (reply || t.finished) : t.finished;
  const done = runtime?.status === 'passed' ? t.image : action;
  const missing = diagnosis?.findings?.length ? diagnosis.findings.map((f) => f.title).join('; ') : (runtime?.status === 'passed' ? t.none : (classifyLogs(runtime?.error || runtime?.logs || '')?.title || t.needRun));
  const why = runtime?.status === 'failed' && runtime.error ? String(runtime.error).split('\n')[0].slice(0, 220) : '';
  const extra = reply && !/RESULT:/i.test(reply) ? reply : '';
  const reportLines = Array.isArray(reports) && reports.length
    ? reports.map((s) => `${s.status === 'done' ? '✅' : '⚠️'} ${s.action}: ${String(s.goal || '').slice(0, 80)}${s.error ? ` (${s.error})` : ''}`).join('\n')
    : '';
  return [`RESULT: ${result}`, why ? `WHY: ${why}` : '', `DONE: ${done}`, `MISSING: ${missing}`, `NEXT: ${next}`, reportLines, extra].filter(Boolean).join('\n');
}

function briefRun(runtime) {
  return [
    `RESULT: App is running.`,
    `TEST LINK: ${runtime.previewPath || runtime.url}`,
    `DONE: Safe preview started, health check and browser test passed.`,
    `MISSING: none for a test run.`,
    `NEXT: Open the test link, then tell me what to change. Tap Publish when you are happy.`,
  ].join('\n');
}

function briefFail(reason) {
  return [
    `RESULT: Not ready.`,
    `WHY: ${String(reason || 'Unknown error').slice(0, 280)}`,
    `MISSING: a passing run.`,
    `NEXT: I can read the error and try a fix. Send the problem in chat.`,
  ].join('\n');
}

function normalizeQuestions(questions) {
  return (Array.isArray(questions) ? questions : []).slice(0, 3).map((q) => {
    if (typeof q === 'string') return { question: q, options: [], required: true };
    return { question: String(q?.question || ''), options: Array.isArray(q?.options) ? q.options.slice(0, 4).map(String) : [], required: q?.required !== false };
  }).filter((q) => q.question);
}

function improvePrompt(project, feedback, context) {
  return `Improve this existing application from the user's feedback.

Project: ${project.name}
Idea: ${project.idea}
User feedback: ${feedback}

Relevant files:
${context}

Return JSON with full file contents for every changed file:
{
  "root_cause": "",
  "files": [{"path":"","content":"full file content"}],
  "explanation": "short beginner-friendly explanation"
}`;
}

async function collectProjectContext(source) {
  const names = ['package.json', 'src/server.js', 'server.js', 'public/index.html', 'public/game.js', 'Dockerfile', 'docker-compose.yml', 'README.md'];
  const existing = new Set(await listFiles(source));
  const chunks = [];
  for (const name of names) {
    if (!existing.has(name)) continue;
    const text = await fs.readFile(path.join(source, name), 'utf8').catch(() => '');
    chunks.push(`--- ${name} ---\n${clampText(text, 3500)}`);
  }
  return chunks.join('\n\n');
}

function friendlyAiError(err) {
  const m = String(err?.message || err);
  if (/API key is not configured/i.test(m) || /No AI provider/i.test(m)) {
    return 'No AI key is configured. Add a DeepSeek or Gemini key in Settings.';
  }
  if (/HTTP 401|HTTP 403/.test(m)) return 'The AI key was rejected. Check Settings.';
  if (/HTTP 429/.test(m)) return 'The AI provider asked us to slow down.';
  return 'The AI provider was unavailable.';
}

function gateAction(action, { files = [], runtime = {}, githubConfigured = false } = {}) {
  const hasFiles = Array.isArray(files) && files.length > 0;
  const ran = runtime.status === 'passed' && runtime.health === true;
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
