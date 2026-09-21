import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listFiles } from '../utils/fsx.js';
import { scanProject } from '../security/scanner.js';
import { createOctokit, redactGitError } from './octokit-client.js';

const exec = promisify(execFile);
const LFS_BYTES = 50 * 1024 * 1024;
const SKIP = /(^|\/)(\.env$|\.git\/|node_modules\/|artifacts\/|data\/|\.DS_Store$)/;

export function githubSetupGuide() {
  return {
    tokenUrl: 'https://github.com/settings/tokens/new',
    tokenTypes: [
      'GitHub has two Personal access token types: Fine-grained and Personal access token (classic).',
      'For this Builder/GHCR fallback flow, use Personal access token (classic) so the required repository, workflow, and GitHub Packages scopes are available.'
    ],
    classic: [
      'Open https://github.com/settings/tokens/new — this is the Tokens (classic) page.',
      'Do not use the Fine-grained token page for this setup.',
      'Select repo, workflow, and write:packages.',
      'Generate the token and paste it only into App Builder Settings → GitHub token.',
      'Never paste the token into your app source code.'
    ],
    workflow: [
      'Open the target repository → Settings → Actions → General.',
      'Under Workflow permissions, choose Read and write permissions if your organization allows changing this default.',
      'Save the setting. The Builder workflow also explicitly requests packages: write; the repository default being Read-only alone is not a reason to block Publish.',
      'If an organization policy prevents write access, the GitHub Actions run must be checked for the exact policy error.'
    ],
    ghcr: [
      'Public visibility allows SoloHost to pull without login, but it does not grant GitHub Actions permission to push.',
      'For an existing GHCR package, open Package settings → Manage Actions access and give this repository Write access, or connect the package to the repository.',
      'The Builder verifies the image tag instead of assuming that a successful source upload means the image exists.',
      'If the existing package cannot be linked or granted Actions access, remove the old package once and rerun Publish so the workflow can create a repository-linked package.'
    ]
  };
}

export function classifyPublishError(err) {
  const status = Number(err?.status || 0);
  const m = redactGitError(err);
  if (status === 401 || /bad credentials|requires authentication|authorization is required/i.test(m)) {
    return { code: 'auth', message: 'GitHub authorization is required. The account could not be authenticated.', fix: 'Open App Builder Settings and use a GitHub Personal access token (classic). Create it at https://github.com/settings/tokens/new with repo, workflow, and write:packages, then paste it into GitHub token.', guide: githubSetupGuide() };
  }
  if (status === 403 && /rate limit/i.test(m)) {
    return { code: 'rate_limit', message: 'GitHub asked us to wait.', fix: 'Wait one minute, then tap Publish once.' };
  }
  if (status === 403 || /permission|protected branch|resource not accessible/i.test(m)) {
    return { code: 'permission', message: 'GitHub accepted the account but refused the requested write operation.', fix: 'This can be caused by a token with missing permissions, a repository you cannot write to, or GitHub Actions being read-only. Check the token first, then open the repository → Settings → Actions → General → Workflow permissions and select Read and write permissions.', guide: githubSetupGuide() };
  }
  if (status === 404 || /not found/i.test(m)) {
    return { code: 'not_found', message: 'The GitHub repository was not found.', fix: 'App Builder will create the repo under the signed-in GitHub account when the token allows it.' };
  }
  if (/could not resolve|enotfound|network|timed out|econnreset/i.test(m)) {
    return { code: 'network', message: 'The network dropped while talking to GitHub.', fix: 'Check the connection and tap Publish once more.' };
  }
  if (/git|push|remote|rejected/i.test(m)) {
    return { code: 'git_push', message: 'GitHub upload failed.', fix: 'Download Project and upload the files on github.com, or tap Publish once after fixing access.' };
  }
  return { code: 'api', message: m.slice(0, 220) || 'GitHub upload failed.', fix: 'I could not identify a safe automatic fix. Open the GitHub repository and check token access, repository permissions, and Actions workflow permissions. If needed, use Download Project as the manual fallback.', guide: githubSetupGuide() };
}

export async function validateReleaseProject(sourceDir) {
  const files = (await listFiles(sourceDir).catch(() => [])).filter((f) => !SKIP.test(f));
  const errors = [];
  if (!files.length) errors.push('The project has no files.');
  if (!files.includes('Dockerfile')) errors.push('Dockerfile is missing.');
  if (!files.some((f) => f === 'docker-compose.yml' || f === 'solohost/docker-compose.yml')) {
    errors.push('docker-compose.yml is missing.');
  }
  if (files.some((f) => f.includes('..') || path.isAbsolute(f))) errors.push('Unsafe file path found.');
  const dockerfile = await fs.readFile(path.join(sourceDir, 'Dockerfile'), 'utf8').catch(() => '');
  const composePaths = ['docker-compose.yml', 'solohost/docker-compose.yml'];
  const composePath = composePaths.find((f) => files.includes(f));
  const compose = composePath ? await fs.readFile(path.join(sourceDir, composePath), 'utf8').catch(() => '') : '';
  if (dockerfile && !/FROM\s+\S+/i.test(dockerfile)) errors.push('Dockerfile has no FROM image.');
  if (dockerfile && /docker\.sock/i.test(dockerfile)) errors.push('Dockerfile must not mount the Docker socket.');
  if (compose && /docker\.sock|privileged\s*:\s*true|cap_add\s*:|security_opt\s*:|network_mode\s*:\s*host|userns_mode\s*:\s*host|devices\s*:/i.test(compose)) errors.push('SoloHost package contains a blocked or unsafe Docker setting (for example docker.sock or privileged mode). Remove it before publishing.');
  if (compose && /(^|\n)\s*build\s*:/i.test(compose)) errors.push('SoloHost does not build images from the package. Use a published Docker image instead.');
  const scan = await scanProject(sourceDir);
  if (scan.critical > 0) errors.push('A secret or critical security issue is still in the project.');
  return { ok: errors.length === 0, errors, files, scan };
}

export async function authenticateGitHub(token) {
  if (!token) {
    const err = new Error('GitHub authorization is required.');
    err.status = 401;
    err.code = 'auth';
    throw err;
  }
  const octokit = await createOctokit({ token });
  try {
    const me = await octokit.rest.users.getAuthenticated();
    const login = me.data?.login;
    if (!login) {
      const err = new Error('GitHub authorization is required.');
      err.status = 401;
      err.code = 'auth';
      throw err;
    }
    return { octokit, login, id: me.data.id };
  } catch (err) {
    const classified = classifyPublishError(err);
    throw Object.assign(new Error(classified.message), { status: err.status, code: classified.code, fix: classified.fix });
  }
}


export async function getWorkflowPermissions({ octokit, owner, repoName }) {
  try {
    const result = await octokit.request({ method: 'GET', url: `/repos/${owner}/${repoName}/actions/permissions/workflow` });
    return { ok: true, defaultWorkflowPermissions: result.data?.default_workflow_permissions || null, canApprovePullRequestReviews: result.data?.can_approve_pull_request_reviews };
  } catch (err) {
    return { ok: false, error: redactGitError(err), status: err.status || 0 };
  }
}

export async function ensureRepository({ octokit, owner, repoName, existingAction = 'confirm' }) {
  try {
    const existing = await octokit.rest.repos.get({ owner, repo: repoName });
    const perms = existing.data.permissions || {};
    if (perms.push === false) {
      const err = new Error('This GitHub token cannot update the repository.');
      err.status = 403;
      err.code = 'permission';
      throw err;
    }
    if (existingAction === 'confirm' || !existingAction) {
      return { repo: existing.data, created: false, requiresConfirmation: true };
    }
    return { repo: existing.data, created: false, requiresConfirmation: false };
  } catch (err) {
    if (err.status !== 404 && err.code !== 'not_found') throw err;
    const created = await octokit.rest.repos.createForAuthenticatedUser({
      name: repoName,
      private: false,
      auto_init: false,
      description: 'Created by App Builder — Pi SoloHost',
      has_issues: false,
      has_projects: false,
      has_wiki: false,
    });
    return { repo: created.data, created: true, requiresConfirmation: false };
  }
}

export async function publishWithGit({ token, repoName, sourceDir, version = '0.1.0', branch = 'main', emit = () => {}, existingAction = 'confirm' }) {
  const report = {
    ok: false,
    stage: 'preparing',
    url: null,
    branch,
    sha: null,
    files: 0,
    method: 'git+octokit',
    error: null,
    fix: null,
    code: null,
    verified: false,
    fallback: null,
  };
  const step = (stage, detail) => { report.stage = stage; emit('github', 'running', detail); };

  try {
    step('preparing', 'Preparing…');
    step('authenticating', 'Authenticating GitHub…');
    const { octokit, login } = await authenticateGitHub(token);
    const owner = login;
    const name = safeRepoName(repoName);
    step('validating', 'Validating…');
    const validation = await validateReleaseProject(sourceDir);
    report.files = validation.files.length;
    if (!validation.ok) {
      report.code = validation.scan?.critical ? 'secret' : 'PROJECT_INVALID';
      report.error = validation.errors.join(' ');
      report.fix = validation.scan?.critical
        ? 'A secret was found. I can remove it if you tap Improve, then Publish again.'
        : 'Tap Check, then Improve. Publish only after files pass.';
      report.fallback = manualFallback(name);
      return report;
    }

    step('checking', 'Checking repository…');
    let ensured;
    try {
      ensured = await ensureRepository({ octokit, owner, repoName: name, existingAction });
    } catch (err) {
      const classified = classifyPublishError(err);
      if (classified.code === 'auth' || classified.code === 'permission') {
        report.code = classified.code;
        report.error = classified.message;
        report.fix = classified.fix;
        report.fallback = manualFallback(name);
        return report;
      }
      throw err;
    }
    if (ensured.created) step('creating', 'Creating repository…');
    if (ensured.requiresConfirmation) {
      report.code = 'REPO_EXISTS';
      report.error = `The GitHub repository ${owner}/${name} already exists.`;
      report.fix = 'Choose Overwrite to replace the repository contents, or Create new repository to keep the existing repository unchanged.';
      report.url = ensured.repo.html_url || `https://github.com/${owner}/${name}`;
      report.repoExists = true;
      report.repo = name;
      report.owner = owner;
      report.choices = [
        { action: 'overwrite', label: 'Overwrite existing repository', repoName: name },
        { action: 'new', label: 'Create new repository', repoName: `${name}-new` }
      ];
      report.guide = githubSetupGuide();
      return report;
    }
    const realOwner = ensured.repo.owner?.login || owner;
    const url = ensured.repo.html_url || `https://github.com/${realOwner}/${name}`;
    const workflow = await getWorkflowPermissions({ octokit, owner: realOwner, repoName: name });
    // IMPORTANT: GitHub's repository setting is a DEFAULT, not proof that the
    // workflow will be read-only. Our generated workflow explicitly requests
    // packages: write. The previous implementation incorrectly blocked Publish
    // whenever the repository default was `read`, even though the workflow was
    // allowed to elevate the GITHUB_TOKEN for its own job.
    report.workflowPermissions = workflow;
    if (workflow.defaultWorkflowPermissions === 'read') {
      report.workflowPermissionNote = 'Repository default GITHUB_TOKEN permission is read-only; the generated workflow explicitly requests packages: write.';
    }

    const workflowText = await fs.readFile(path.join(sourceDir, '.github', 'workflows', 'docker.yml'), 'utf8').catch(() => '');
    if (!/packages\s*:\s*write/i.test(workflowText)) {
      report.code = 'github_workflow_permission';
      report.error = 'The Docker workflow does not request permission to publish the image to GHCR.';
      report.fix = 'I found the workflow permission problem before upload. The Builder will repair the workflow to request packages: write, then validate it again.';
      report.url = url;
      report.owner = realOwner;
      report.repo = name;
      report.guide = githubSetupGuide();
      report.fallback = manualFallback(name);
      return report;
    }

    step('publishing', 'Publishing source…');
    const work = await copyWorktree(sourceDir, validation.files);
    try {
      let sha = null;
      let lastPublishError = null;
      try {
        sha = await gitPushWorktree({ work, token, owner: realOwner, repo: name, branch, version });
      } catch (gitErr) {
        lastPublishError = gitErr;
        step('publishing', 'Git upload failed, retrying with the GitHub API…');
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            sha = await publishWorktreeWithGitHubApi({ octokit, work, owner: realOwner, repo: name, branch, version });
            lastPublishError = null;
            break;
          } catch (err) {
            lastPublishError = err;
            if (err?.code !== 'conflict' || attempt === 3) break;
            step('retrying', `GitHub changed while uploading; retrying (${attempt}/2)…`);
          }
        }
      }
      if (!sha) throw lastPublishError || new Error('GitHub upload did not return a commit SHA.');
      step('verifying', 'Verifying GitHub…');
      const verified = await verifyRemote({ octokit, owner: realOwner, repo: name, sha });
      if (!verified.ok) {
        report.code = 'verify';
        report.error = 'GitHub upload finished but the commit could not be verified.';
        report.fix = 'Open the repository and confirm the files, or tap Download Project.';
        report.url = url;
        report.fallback = manualFallback(name);
        return report;
      }
      report.ok = true;
      report.verified = true;
      report.stage = 'github_verified';
      report.url = url;
      report.sha = sha;
      report.owner = realOwner;
      report.repo = name;
      report.install = solohostInstall(url, `${realOwner}/${name}`, version);
      emit('github', 'done', `GitHub ready: ${url}`);
      return report;
    } finally {
      await fs.rm(work, { recursive: true, force: true }).catch(() => {});
    }
  } catch (err) {
    const classified = classifyPublishError(err);
    report.ok = false;
    report.code = classified.code;
    report.error = classified.message;
    report.fix = classified.fix;
    report.fallback = manualFallback(repoName);
    report.detail = redactGitError(err);
    return report;
  }
}

export function manualFallback(repoName) {
  const name = safeRepoName(repoName || 'my-app');
  return {
    action: 'download',
    label: 'Download Project',
    scriptLabel: 'Windows GitHub Publisher',
    scriptFilename: 'GitHub-ZIP-Image-Publisher-v4.0.ps1',
    steps: [
      'Download the project ZIP and the Windows GitHub Publisher fallback script.',
      `On github.com create a new empty repository named ${name}, or choose an existing repository only after confirming overwrite.`,
      'Run the PowerShell script on Windows and follow its guided prompts. It verifies the GitHub account, uploads the files, verifies the repository, checks the GHCR image tag, and prints SoloHost install steps.',
      'Do not install on SoloHost until the script confirms ghcr.io/OWNER/REPOSITORY:VERSION exists and is pullable.',
    ],
  };
}

function safeRepoName(value) {
  return String(value || 'app').toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'app';
}

async function copyWorktree(sourceDir, files) {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-git-'));
  for (const rel of files) {
    if (SKIP.test(rel)) continue;
    const from = path.join(sourceDir, rel);
    const to = path.join(work, rel);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(from, to);
  }
  const ignore = ['.env', '.env.*', 'node_modules/', 'artifacts/', 'data/', '*.db', '.git/'].join('\n') + '\n';
  await fs.writeFile(path.join(work, '.gitignore'), ignore);
  return work;
}

export async function publishWorktreeWithGitHubApi({ octokit, work, owner, repo, branch = 'main', version = '0.1.0' }) {
  const files = (await listFiles(work)).filter((rel) => !SKIP.test(rel));
  if (!files.length) throw Object.assign(new Error('The project has no publishable files.'), { code: 'PROJECT_EMPTY' });

  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  let headSha = null;
  try {
    const ref = await octokit.request({ method: 'GET', url: `${repoPath}/git/ref/heads/${encodeURIComponent(branch)}` });
    headSha = ref.data?.object?.sha || null;
  } catch (err) {
    if (Number(err?.status) !== 404 && !/empty|not found/i.test(String(err?.message || ''))) throw err;
  }

  const entries = [];
  const concurrency = 6;
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= files.length) return;
      const rel = files[i];
      const content = await fs.readFile(path.join(work, rel));
      const blob = await octokit.request({
        method: 'POST',
        url: `${repoPath}/git/blobs`,
        data: { content: content.toString('base64'), encoding: 'base64' },
      });
      entries[i] = { path: rel, mode: '100644', type: 'blob', sha: blob.data?.sha };
      if (!entries[i].sha) throw new Error(`GitHub did not return a blob SHA for ${rel}.`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));

  let baseTreeSha = null;
  if (headSha) {
    const commit = await octokit.request({ method: 'GET', url: `${repoPath}/git/commits/${headSha}` });
    baseTreeSha = commit.data?.tree?.sha || null;
  }
  const tree = await octokit.request({
    method: 'POST',
    url: `${repoPath}/git/trees`,
    data: { ...(baseTreeSha ? { base_tree: baseTreeSha } : {}), tree: entries },
  });
  const commit = await octokit.request({
    method: 'POST',
    url: `${repoPath}/git/commits`,
    data: {
      message: `chore: release ${version} from App Builder`,
      tree: tree.data?.sha,
      ...(headSha ? { parents: [headSha] } : {}),
    },
  });
  const commitSha = commit.data?.sha;
  if (!commitSha) throw new Error('GitHub did not return the new commit SHA.');

  try {
    if (headSha) {
      await octokit.request({
        method: 'PATCH',
        url: `${repoPath}/git/refs/heads/${encodeURIComponent(branch)}`,
        data: { sha: commitSha, force: false },
      });
    } else {
      await octokit.request({
        method: 'POST',
        url: `${repoPath}/git/refs`,
        data: { ref: `refs/heads/${branch}`, sha: commitSha },
      });
    }
  } catch (err) {
    if (Number(err?.status) === 409 || /fast.?forward|reference/i.test(String(err?.message || ''))) {
      const conflict = new Error('GitHub repository changed while publishing.');
      conflict.status = 409;
      conflict.code = 'conflict';
      throw conflict;
    }
    throw err;
  }
  return commitSha;
}

async function gitPushWorktree({ work, token, owner, repo, branch, version }) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' };
  const git = async (args, timeout = 120000) => {
    const { stdout, stderr } = await exec('git', args, { cwd: work, env, timeout, maxBuffer: 8 * 1024 * 1024 });
    return `${stdout || ''}${stderr || ''}`;
  };
  await git(['init']);
  await git(['config', 'user.email', 'builder@app-builder.local']);
  await git(['config', 'user.name', 'App Builder']);
  await git(['config', 'commit.gpgsign', 'false']);
  const large = [];
  for (const rel of await listFiles(work)) {
    const st = await fs.stat(path.join(work, rel)).catch(() => null);
    if (st && st.size >= LFS_BYTES) large.push(rel);
  }
  if (large.length) {
    await exec('git', ['lfs', 'install', '--local'], { cwd: work, env, timeout: 30000 }).catch(() => {});
    for (const rel of large) await git(['lfs', 'track', rel]).catch(() => {});
  }
  await git(['add', '-A']);
  const status = await git(['status', '--porcelain']);
  if (status.trim()) await git(['commit', '-m', `release ${version} from App Builder`]);
  await git(['branch', '-M', branch]);
  const remote = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
  await git(['remote', 'add', 'origin', remote]);
  let last;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await git(['push', '-u', 'origin', `HEAD:${branch}`], 180000);
      last = null;
      break;
    } catch (err) {
      last = err;
      const classified = classifyPublishError(err);
      if (classified.code !== 'network') throw Object.assign(err, { code: 'git_push' });
      await new Promise((r) => setTimeout(r, 400 * (2 ** attempt)));
    }
  }
  if (last) throw Object.assign(last, { code: 'git_push' });
  const sha = (await git(['rev-parse', 'HEAD'])).trim();
  await git(['remote', 'set-url', 'origin', `https://github.com/${owner}/${repo}.git`]).catch(() => {});
  return sha;
}

async function verifyRemote({ octokit, owner, repo, sha }) {
  try {
    const remote = await octokit.rest.repos.get({ owner, repo });
    const branch = remote.data.default_branch || 'main';
    const ref = await octokit.request({ method: 'GET', url: `/repos/${owner}/${repo}/commits/${encodeURIComponent(sha || branch)}` }).catch(() => null);
    return { ok: Boolean(remote.data.html_url && (ref?.data?.sha || sha)), defaultBranch: branch };
  } catch {
    return { ok: false };
  }
}

function solohostInstall(repoUrl, imageName, version) {
  return [
    `Repository: ${repoUrl}`,
    `Image after GitHub Actions: ghcr.io/${String(imageName).toLowerCase()}:${version}`,
    'SoloHost install:',
    '1. Wait until the GitHub Action finishes building the image.',
    '2. In Pi Desktop SoloHost, add an app.',
    '3. Use docker-compose.yml and config_options.yml from the repo.',
    '4. Start the app.',
  ].join('\n');
}
