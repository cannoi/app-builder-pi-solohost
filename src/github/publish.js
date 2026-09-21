import { writeGithubWorkflow } from '../projects/generator.js';
import { publishWithGit, validateReleaseProject, manualFallback, githubSetupGuide } from './git-publisher.js';

export async function publishToGitHub({ github, project, sourceDir, version = '0.1.0', emit = () => {}, runtimeOk = true, repoName = null, existingAction = 'confirm' }) {
  const report = {
    ok: false,
    stage: 'preparing',
    url: null,
    branch: null,
    sha: null,
    files: 0,
    code: null,
    error: null,
    fix: null,
    steps: [],
    install: null,
    fallback: null,
    verified: false,
  };
  const step = (name, detail) => { report.stage = name; report.steps.push(`${name}: ${detail}`); emit('github', 'running', detail); };

  if (!github.configured()) {
    report.code = 'GITHUB_NOT_CONFIGURED';
    report.error = 'GitHub authorization is required.';
    report.fix = 'Open Settings and paste a GitHub token. Then tap Publish.';
    report.fallback = manualFallback(project.slug);
    report.guide = githubSetupGuide?.();
    return report;
  }
  if (!runtimeOk) {
    report.code = 'BUILD_REQUIRED';
    report.error = 'The app has not passed a live test yet.';
    report.fix = 'Tap Run first. Publish stays locked until the preview works.';
    report.fallback = manualFallback(project.slug);
    return report;
  }
  step('preparing', 'Preparing…');
  // Keep the GHCR tag in the workflow identical to the release being published.
  // The old code generated the workflow from project.version before release notes,
  // which could leave GitHub Actions building an older tag than the installer used.
  await writeGithubWorkflow(sourceDir, { ...project, version });
  step('validating', 'Validating…');
  const validation = await validateReleaseProject(sourceDir);
  if (!validation.ok) {
    report.code = 'PROJECT_INVALID';
    report.error = (validation.errors || []).join(' ');
    report.fix = 'Tap Check, then Improve. I will not publish files that fail validation.';
    report.fallback = manualFallback(project.slug);
    return report;
  }
  const token = github.getToken?.() || github.cfg.github.token;
  const gitResult = await publishWithGit({
    token,
    repoName: repoName || project.slug,
    sourceDir,
    version,
    branch: null,
    emit,
    existingAction,
  });
  return { ...report, ...gitResult, steps: report.steps.concat(gitResult.stage || []) };
}

export function fixFor(code, message = '') {
  const map = {
    GITHUB_NOT_CONFIGURED: 'Open Settings and add a GitHub token.',
    auth: 'GitHub could not authenticate the account. Use a Personal access token (classic) from https://github.com/settings/tokens/new with repo, workflow, and write:packages.',
    permission: 'GitHub refused a write operation. Check the token permissions and GitHub → Repository → Settings → Actions → General → Workflow permissions → Read and write permissions.',
    REPO_EXISTS: 'This repository already exists. Choose Overwrite or Create new repository.',
    registry_unauthorized: 'The GHCR image cannot be downloaded. The package may be private, the image name may be wrong, or registry access is missing.',
    github_workflow_permission: 'GitHub Actions is read-only. Open Repository → Settings → Actions → General → Workflow permissions → Read and write permissions → Save.',
    rate_limit: 'Wait one minute, then tap Publish once.',
    PROJECT_INVALID: 'Tap Check, then Improve.',
    BUILD_REQUIRED: 'Tap Run first.',
    secret: 'A secret was found. Tap Improve, then Publish.',
    git_push: 'GitHub upload failed. I will explain the likely cause and give the exact setup steps instead of showing only the raw error.',
    not_found: 'The repository was missing. App Builder will create it when the token allows.',
  };
  return map[code] || String(message).slice(0, 180);
}
