import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { listFiles } from '../utils/fsx.js';
import { scanProject } from '../security/scanner.js';
import { GitHubImageUploader } from './uploader.js';

const API = 'https://api.github.com';

export function gitBlobSha(buffer) {
  const body = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  return crypto.createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
}

export function buildGitTreeUpdates(localEntries, remoteEntries) {
  const local = new Map(localEntries.map((x) => [x.path, x.sha]));
  const updates = localEntries.map((x) => ({ path: x.path, mode: x.mode || '100644', type: 'blob', sha: x.sha }));
  for (const remote of remoteEntries || []) {
    if (remote.type === 'blob' && !local.has(remote.path)) updates.push({ path: remote.path, mode: '100644', type: 'blob', sha: null });
  }
  return updates;
}


export function classifyGitHubError(status, message = '') {
  const s = Number(status || 0); const m = String(message);
  if (s === 401 || /bad credentials|authentication/i.test(m)) return 'auth';
  if (s === 403 && /rate limit/i.test(m)) return 'rate_limit';
  if (s === 404) return 'not_found';
  if (s === 409 && /empty/i.test(m)) return 'empty_repo';
  if (s === 422 && /reference|fast.?forward/i.test(m)) return 'conflict';
  if (s >= 500) return 'server';
  return 'api';
}

export async function validateProjectForPublish(sourceDir) {
  const files = await listFiles(sourceDir).catch(() => []);
  const publishable = files.filter((f) => f !== '.env' && !f.endsWith('/.env'));
  const errors = [];
  if (!publishable.length) errors.push('The project has no publishable files.');
  if (!publishable.some((f) => f === 'Dockerfile')) errors.push('Dockerfile is missing.');
  return { ok: errors.length === 0, errors, files: publishable };
}

export class GitHubManager {
  constructor({ cfg, log }) { this.cfg = cfg; this.log = log; this.ownerType = null; this.authenticatedLogin = null; this.uploader = new GitHubImageUploader(this); }

  getToken() { return this.cfg.github?.token || this.cfg.githubToken || process.env.GITHUB_TOKEN || ''; }

  async uploadImage(repo, filePath, imageInput, message) { return this.uploader.uploadImage(repo, filePath, imageInput, message); }

  configured() { return Boolean((this.cfg.github?.token || this.cfg.githubToken) && this.cfg.github?.owner); }

  headers() {
    return {
      Authorization: `Bearer ${this.cfg.github?.token || this.cfg.githubToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'pi-app-factory',
    };
  }

  async createAndPush(project, sourceDir, { privateRepo = true, version = '0.1.0' } = {}) {
    if (!this.configured()) {
      const err = new Error('GitHub is not configured. Add a token and owner in Settings.');
      err.code = 'GITHUB_NOT_CONFIGURED';
      throw err;
    }
    const scan = await scanProject(sourceDir);
    if (scan.critical > 0) {
      const err = new Error('Push blocked: a secret or critical issue was found in the project.');
      err.code = 'BLOCK_PUSH'; err.scan = scan; throw err;
    }
    const name = project.slug;
    const repo = await this.ensureRepo(name, privateRepo);
    const owner = repo.owner?.login || this.cfg.github.owner;
    const branch = repo.default_branch || 'main';
    const repoPath = `${owner}/${name}`;
    const localEntries = [];
    const fileBytes = [];
    for (const rel of await listFiles(sourceDir)) {
      if (rel === '.env' || rel.endsWith('/.env') || rel.includes('.git/')) continue;
      const content = await fs.readFile(path.join(sourceDir, rel));
      fileBytes.push({ path: rel, content });
    }
    try {
      for (const file of fileBytes) {
        const blob = await this.api('POST', `/repos/${repoPath}/git/blobs`, { content: file.content.toString('base64'), encoding: 'base64' });
        localEntries.push({ path: file.path, sha: blob.sha, localSha: gitBlobSha(file.content), mode: '100644' });
      }
    } catch (err) {
      if (err.status === 404 || err.code === 'not_found' || err.code === 'empty_repo') {
        return this.pushViaContents({ owner, name, branch, repo, fileBytes, version });
      }
      throw err;
    }

    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const head = await this.getBranchHead(owner, name, branch);
        const baseTree = head ? await this.api('GET', `/repos/${repoPath}/git/commits/${head.sha}`) : null;
        const remoteTree = baseTree ? await this.api('GET', `/repos/${repoPath}/git/trees/${baseTree.tree.sha}?recursive=1`) : { tree: [] };
        const updates = buildGitTreeUpdates(localEntries, remoteTree.tree || []);
        const treePayload = { tree: head ? updates : updates.filter((x) => x.sha) };
        if (baseTree?.tree?.sha) treePayload.base_tree = baseTree.tree.sha;
        const tree = await this.api('POST', `/repos/${repoPath}/git/trees`, treePayload);
        const commit = await this.api('POST', `/repos/${repoPath}/git/commits`, {
          message: `chore: release ${version} from Pi App Factory`,
          tree: tree.sha,
          ...(head ? { parents: [head.sha] } : {}),
        });
        if (head) {
          await this.api('PATCH', `/repos/${repoPath}/git/refs/heads/${encodeURIComponent(branch)}`, { sha: commit.sha, force: false });
        } else {
          await this.api('POST', `/repos/${repoPath}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
        }
        const verification = await this.verifyPublishedFiles(owner, name, branch, localEntries);
        if (!verification.ok) throw new Error(`GitHub verification failed: ${verification.missing.join(', ') || verification.mismatched.join(', ')}`);
        return { url: repo.html_url, sha: commit.sha, files: localEntries.length, branch, verification, emptyInitialized: !head };
      } catch (err) {
        lastError = err;
        if (err.status === 404 || err.code === 'not_found' || err.code === 'empty_repo') {
          return this.pushViaContents({ owner, name, branch, repo, fileBytes, version });
        }
        if (attempt === 3 || !/409|422|fast.?forward|reference/i.test(String(err.message))) throw err;
        this.log.warn('GitHub head changed during publish; retrying', { attempt, error: err.message });
      }
    }
    throw lastError || new Error('GitHub publish failed.');
  }

  async pushViaContents({ owner, name, branch, repo, fileBytes, version }) {
    const repoPath = `${owner}/${name}`;
    let uploaded = 0;
    for (const file of fileBytes) {
      const encodedPath = file.path.split('/').map(encodeURIComponent).join('/');
      let sha = null;
      const existing = await this.api('GET', `/repos/${repoPath}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`).catch((err) => {
        if (err.status === 404 || err.code === 'not_found' || err.code === 'empty_repo') return null;
        throw err;
      });
      if (existing?.sha) sha = existing.sha;
      await this.api('PUT', `/repos/${repoPath}/contents/${encodedPath}`, {
        message: `chore: release ${version} ${file.path}`,
        content: file.content.toString('base64'),
        branch,
        ...(sha ? { sha } : {}),
      });
      uploaded += 1;
    }
    return {
      url: repo.html_url || `https://github.com/${repoPath}`,
      sha: null,
      files: uploaded,
      branch,
      verification: { ok: uploaded === fileBytes.length, missing: [], mismatched: [], verifiedFiles: uploaded },
      emptyInitialized: true,
      method: 'contents',
    };
  }

  async verifyPublishedFiles(owner, repoName, branch, localEntries) {
    const head = await this.getBranchHead(owner, repoName, branch);
    if (!head) return { ok: false, missing: localEntries.map((x) => x.path), mismatched: [] };
    const commit = await this.api('GET', `/repos/${owner}/${repoName}/git/commits/${head.sha}`);
    const tree = await this.api('GET', `/repos/${owner}/${repoName}/git/trees/${commit.tree.sha}?recursive=1`);
    const remote = new Map((tree.tree || []).filter((x) => x.type === 'blob').map((x) => [x.path, x.sha]));
    const missing = []; const mismatched = [];
    for (const entry of localEntries) {
      const sha = remote.get(entry.path);
      if (!sha) missing.push(entry.path);
      else if (sha !== entry.sha && sha !== entry.localSha) mismatched.push(entry.path);
    }
    return { ok: missing.length === 0 && mismatched.length === 0, missing, mismatched, verifiedFiles: localEntries.length, commit: head.sha };
  }

  async latestWorkflowRun(repoName, workflowFile = 'docker.yml', { headSha = null, branch = null } = {}) {
    const owner = encodeURIComponent(this.cfg.github.owner);
    const repo = encodeURIComponent(repoName);
    try {
      const params = new URLSearchParams({ per_page: '10' });
      if (headSha) params.set('head_sha', headSha);
      if (branch) params.set('branch', branch);
      const result = await this.api('GET', `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?${params.toString()}`);
      const run = Array.isArray(result.workflow_runs)
        ? result.workflow_runs.find((item) => !headSha || item.head_sha === headSha) || result.workflow_runs[0]
        : null;
      return run ? {
        id: run.id,
        status: run.status || null,
        conclusion: run.conclusion || null,
        html_url: run.html_url || null,
        created_at: run.created_at || null,
        updated_at: run.updated_at || null,
        head_sha: run.head_sha || null,
        head_branch: run.head_branch || null,
        run_number: run.run_number || null,
      } : null;
    } catch {
      try {
        const all = await this.api('GET', `/repos/${owner}/${repo}/actions/runs?per_page=15`);
        const runs = Array.isArray(all.workflow_runs) ? all.workflow_runs : [];
        const run = runs.find((item) => !headSha || item.head_sha === headSha) || runs[0];
        return run ? {
          id: run.id,
          status: run.status || null,
          conclusion: run.conclusion || null,
          html_url: run.html_url || null,
          created_at: run.created_at || null,
          updated_at: run.updated_at || null,
          head_sha: run.head_sha || null,
          head_branch: run.head_branch || null,
          run_number: run.run_number || null,
        } : null;
      } catch {
        return null;
      }
    }
  }

  async actionJobLogs(owner, repoName, jobId) {
    const who = encodeURIComponent(owner || this.cfg.github.owner);
    const repo = encodeURIComponent(repoName);
    const id = encodeURIComponent(String(jobId));
    const res = await fetch(`${API}/repos/${who}/${repo}/actions/jobs/${id}/logs`, {
      headers: this.headers(),
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`GitHub ${res.status}: ${raw.slice(0, 300)}`);
    return redactActionLog(raw);
  }

  async workflowDiagnostics(repoName, runId) {
    const owner = this.cfg.github.owner;
    const run = await this.api('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/actions/runs/${encodeURIComponent(String(runId))}`);
    const jobsResult = await this.api('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/actions/runs/${encodeURIComponent(String(runId))}/jobs?per_page=100`);
    const jobs = Array.isArray(jobsResult.jobs) ? jobsResult.jobs : [];
    const failedJobs = jobs.filter((job) => job.conclusion && job.conclusion !== 'success');
    const details = [];
    for (const job of (failedJobs.length ? failedJobs : jobs).slice(0, 5)) {
      let logs = '';
      try { logs = readableActionLog(await this.actionJobLogs(owner, repoName, job.id)); } catch (err) { logs = `Unable to read job log: ${String(err?.message || err).slice(0, 220)}`; }
      const failedSteps = (job.steps || []).filter((step) => step.conclusion && step.conclusion !== 'success').map((step) => ({ name: step.name, status: step.status, conclusion: step.conclusion }));
      details.push({
        id: job.id,
        name: job.name || null,
        status: job.status || null,
        conclusion: job.conclusion || null,
        started_at: job.started_at || null,
        completed_at: job.completed_at || null,
        html_url: job.html_url || null,
        failed_steps: failedSteps,
        log: extractActionFailure(logs, failedSteps),
      });
    }
    const combined = details.map((d) => `JOB: ${d.name || d.id} (${d.conclusion || d.status})\nFAILED STEPS: ${(d.failed_steps || []).map((s) => s.name).join(', ') || 'none listed'}\nLOG:\n${d.log}`).join('\n\n');
    return {
      run: run ? { id: run.id, status: run.status, conclusion: run.conclusion, html_url: run.html_url, head_sha: run.head_sha, head_branch: run.head_branch } : { id: runId },
      jobs: details,
      summary: `GitHub Actions ${run?.conclusion || run?.status || 'unknown'}; ${failedJobs.length} failed job(s).`,
      logTail: combined.slice(-14000),
    };
  }

  async verifyContainerImage(packageName, tag) {
    const owner = encodeURIComponent(this.cfg.github.owner);
    const pkg = encodeURIComponent(packageName.split('/').pop());
    const type = await this.getOwnerType();
    const base = type === 'Organization' ? `/orgs/${owner}` : `/user`;
    const versions = await this.api('GET', `${base}/packages/container/${pkg}/versions?per_page=100`);
    const match = Array.isArray(versions) && versions.find((v) => Array.isArray(v.metadata?.container?.tags) && v.metadata.container.tags.includes(tag));
    return { ok: Boolean(match), tag, package: packageName, versionId: match?.id || null };
  }

  async setContainerPublic(packageName) {
    const encoded = encodeURIComponent(packageName.split('/').pop());
    const owner = encodeURIComponent(this.cfg.github.owner);
    const type = await this.getOwnerType();
    const base = type === 'Organization' ? `/orgs/${owner}` : `/user`;
    return this.api('PATCH', `${base}/packages/container/${encoded}`, { visibility: 'public' });
  }

  async createRelease(repoName, version, notes) {
    const owner = this.cfg.github.owner;
    return this.api('POST', `/repos/${owner}/${repoName}/releases`, { tag_name: `v${version}`, name: `v${version}`, body: notes || `Release ${version} created by Pi App Factory.`, draft: false, prerelease: version.startsWith('0.') });
  }

  async ensureRepo(name, privateRepo) {
    const configured = this.cfg.github.owner;
    let existing = await this.api('GET', `/repos/${configured}/${name}`).catch(() => null);
    if (existing) {
      this.cfg.github.owner = existing.owner?.login || configured;
      return existing;
    }
    const type = await this.getOwnerType().catch(() => 'User');
    const endpoint = type === 'Organization' ? `/orgs/${configured}/repos` : '/user/repos';
    const created = await this.api('POST', endpoint, { name, private: false, auto_init: false, description: 'Created by App Builder — Pi SoloHost', has_issues: false, has_projects: false, has_wiki: false });
    if (created.owner?.login) this.cfg.github.owner = created.owner.login;
    return created;
  }

  async getOwnerType() {
    if (this.ownerType) return this.ownerType;
    const user = await this.api('GET', `/users/${encodeURIComponent(this.cfg.github.owner)}`);
    this.ownerType = user.type || 'User';
    this.authenticatedLogin = this.authenticatedLogin || user.login;
    return this.ownerType;
  }

  async getBranchHead(owner, repoName, branch) {
    const who = owner || this.cfg.github.owner;
    return this.api('GET', `/repos/${who}/${repoName}/git/ref/heads/${encodeURIComponent(branch)}`).then((r) => ({ sha: r.object.sha })).catch((err) => {
      if (/GitHub 404|GitHub 409|empty.*repository|repository is empty/i.test(err.message) || err.code === 'empty_repo' || err.code === 'not_found') return null;
      throw err;
    });
  }

  async api(method, pathname, body) {
    const res = await fetch(`${API}${pathname}`, { method, headers: { ...this.headers(), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    if (!res.ok) { const err = new Error(`GitHub ${res.status}: ${text.slice(0, 300)}`); err.status = res.status; err.code = classifyGitHubError(res.status, text); throw err; }
    return text ? JSON.parse(text) : {};
  }
}

function redactActionLog(value) {
  return String(value || '')
    .replace(/ghp_[A-Za-z0-9_\-]+/g, 'ghp_***')
    .replace(/github_pat_[A-Za-z0-9_\-]+/g, 'github_pat_***')
    .replace(/AIza[0-9A-Za-z_\-]+/g, 'AIza***')
    .replace(/sk-[0-9A-Za-z_\-]{20,}/g, 'sk-***')
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer ***')
    .replace(/(GEMINI_API_KEY|DEEPSEEK_API_KEY|GITHUB_TOKEN)=([^\s]+)/gi, '$1=***');
}

function readableActionLog(raw) {
  const text = String(raw || '');
  if (!text || text.startsWith('PK') || text.includes('\u0000')) {
    return 'Job log was not readable as text (GitHub returned a binary archive). Failed step names above are the evidence.';
  }
  return redactActionLog(text);
}

function extractActionFailure(log, failedSteps = []) {
  const lines = String(log || '').split(/\r?\n/).map((l) => l.replace(/^\d{4}-\d{2}-\d{2}T[^\s]+\s/, '').trim()).filter(Boolean);
  const hits = lines.filter((l) => /error|failed|fatal|cannot|unable|exit code|not found|denied|unauthorized|timeout|did not become reachable/i.test(l) && !/^echo |^set -euo|^#\[group\]|^#\[debug\]/i.test(l));
  const picked = (hits.length ? hits.slice(-20) : lines.slice(-20)).join('\n');
  const steps = failedSteps.map((s) => s.name).filter(Boolean).join(', ');
  return [steps ? `Failed step(s): ${steps}` : '', picked].filter(Boolean).join('\n').slice(-4000);
}
