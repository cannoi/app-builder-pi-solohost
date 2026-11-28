/**
 * Git-first GitHub source publish for SoloHost Builder apps.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { explainGitHubError, formatUserFacingError } from './user-errors.js';

const exec = promisify(execFile);
const SKIP = /(^|\/)(\.env$|\.env\.|\.git\/|node_modules\/|artifacts\/|data\/|projects\/|workspace\/|\.DS_Store$|.*\.(zip|db|sqlite|log)$)/;

async function listFiles(root) {
  const out = [];
  async function walk(dir, base = '') {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const rel = base ? `${base}/${e.name}` : e.name;
      if (SKIP.test(rel)) continue;
      if (e.isDirectory()) await walk(path.join(dir, e.name), rel);
      else out.push(rel);
    }
  }
  await walk(root);
  return out;
}

async function gitAvailable() {
  try {
    await exec('git', ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function api(token, method, urlPath, body) {
  const res = await fetch(`https://api.github.com${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'solohost-github-upload',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
  if (!res.ok) {
    const err = new Error(data.message || `GitHub HTTP ${res.status}`);
    err.status = res.status;
    err.response = data;
    throw err;
  }
  return { data, headers: res.headers, status: res.status };
}

/**
 * @param {object} opts
 * @param {string} opts.token
 * @param {string} [opts.owner]
 * @param {string} opts.repo
 * @param {string} opts.sourceDir
 * @param {string} [opts.branch='main']
 * @param {string} [opts.version='0.1.0']
 * @param {boolean} [opts.force=false]
 * @param {(msg:string)=>void} [opts.onProgress]
 * @param {string} [opts.locale='en']
 */
export async function publishSourceToGitHub(opts = {}) {
  const {
    token,
    owner: ownerOpt,
    repo,
    sourceDir,
    branch = 'main',
    version = '0.1.0',
    force = false,
    onProgress = () => {},
    locale = 'en',
  } = opts;

  const fail = (err) => {
    const explained = explainGitHubError(err, { locale });
    return {
      ok: false,
      ...explained,
      error: explained.userTitle,
      fix: explained.userAction,
      message: formatUserFacingError(explained),
      detail: String(err?.message || err).slice(0, 800),
    };
  };

  if (!token) return fail(Object.assign(new Error('GitHub authorization is required'), { code: 'auth' }));
  if (!repo || !sourceDir) return fail(new Error('repo and sourceDir are required'));

  try {
    onProgress('Checking GitHub account…');
    const me = await api(token, 'GET', '/user');
    const login = me.data?.login;
    if (!login) return fail(Object.assign(new Error('Bad credentials'), { status: 401 }));
    const scopes = String(me.headers?.get?.('x-oauth-scopes') || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (scopes.length && !scopes.includes('workflow')) {
      return fail(Object.assign(new Error('without workflow scope'), { code: 'workflow_scope' }));
    }
    const owner = ownerOpt || login;
    onProgress(scopes.length ? `Signed in as ${login}` : `Signed in as ${login}`);

    onProgress('Checking repository…');
    let repoInfo;
    try {
      repoInfo = (await api(token, 'GET', `/repos/${owner}/${repo}`)).data;
    } catch (err) {
      if (err.status === 404) {
        onProgress('Creating repository…');
        repoInfo = (await api(token, 'POST', '/user/repos', {
          name: repo,
          private: false,
          auto_init: false,
        })).data;
      } else throw err;
    }
    const realOwner = repoInfo.owner?.login || owner;
    const url = repoInfo.html_url || `https://github.com/${realOwner}/${repo}`;
    const useBranch = branch || repoInfo.default_branch || 'main';

    const files = await listFiles(sourceDir);
    if (!files.length) return fail(new Error('The project has no publishable files.'));

    const work = await fs.mkdtemp(path.join(os.tmpdir(), 'gh-up-'));
    try {
      for (const rel of files) {
        const from = path.join(sourceDir, rel);
        const to = path.join(work, rel);
        await fs.mkdir(path.dirname(to), { recursive: true });
        await fs.copyFile(from, to);
      }
      await fs.writeFile(path.join(work, '.gitignore'), 'node_modules/\n.env\nartifacts/\ndata/\n');

      if (await gitAvailable()) {
        onProgress('Uploading with git…');
        const env = {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_ASKPASS: 'echo',
        };
        const git = (args, timeout = 120000) => exec('git', args, { cwd: work, env, timeout, maxBuffer: 20 * 1024 * 1024 });
        await git(['init']);
        await git(['config', 'user.email', 'builder@localhost']);
        await git(['config', 'user.name', 'App Builder']);
        await git(['config', 'commit.gpgsign', 'false']);
        await git(['add', '-A']);
        await git(['commit', '-m', `release ${version}`]).catch(() => {});
        await git(['branch', '-M', useBranch]);
        const remote = `https://x-access-token:${token}@github.com/${realOwner}/${repo}.git`;
        await git(['remote', 'add', 'origin', remote]);
        try {
          if (force) {
            try {
              await git(['push', '--force-with-lease', '-u', 'origin', `HEAD:${useBranch}`], 180000);
            } catch (e) {
              if (/workflow scope|update workflow/i.test(String(e?.message || e))) throw e;
              await git(['push', '--force', '-u', 'origin', `HEAD:${useBranch}`], 180000);
            }
          } else {
            await git(['push', '-u', 'origin', `HEAD:${useBranch}`], 180000);
          }
        } catch (e) {
          await git(['remote', 'set-url', 'origin', `https://github.com/${realOwner}/${repo}.git`]).catch(() => {});
          throw e;
        }
        await git(['remote', 'set-url', 'origin', `https://github.com/${realOwner}/${repo}.git`]).catch(() => {});
        const sha = (await git(['rev-parse', 'HEAD'])).stdout?.trim?.() || (await git(['rev-parse', 'HEAD'])).toString().trim();
        onProgress(`GitHub ready: ${url}`);
        return { ok: true, url, owner: realOwner, repo, branch: useBranch, sha, method: 'git' };
      }

      onProgress('Git not found — using GitHub API…');
      // Minimal API path: sequential blobs (slower, fallback only)
      let parent = null;
      try {
        const ref = await api(token, 'GET', `/repos/${realOwner}/${repo}/git/ref/heads/${useBranch}`);
        parent = ref.data.object?.sha;
      } catch { /* empty repo */ }
      const tree = [];
      for (const rel of files) {
        const content = await fs.readFile(path.join(work, rel));
        const blob = await api(token, 'POST', `/repos/${realOwner}/${repo}/git/blobs`, {
          content: content.toString('base64'),
          encoding: 'base64',
        });
        tree.push({ path: rel, mode: '100644', type: 'blob', sha: blob.data.sha });
      }
      let base_tree;
      if (parent) {
        const c = await api(token, 'GET', `/repos/${realOwner}/${repo}/git/commits/${parent}`);
        base_tree = c.data.tree?.sha;
      }
      const treeRes = await api(token, 'POST', `/repos/${realOwner}/${repo}/git/trees`, {
        ...(base_tree ? { base_tree } : {}),
        tree,
      });
      const commit = await api(token, 'POST', `/repos/${realOwner}/${repo}/git/commits`, {
        message: `release ${version}`,
        tree: treeRes.data.sha,
        ...(parent ? { parents: [parent] } : {}),
      });
      const sha = commit.data.sha;
      try {
        if (parent) {
          await api(token, 'PATCH', `/repos/${realOwner}/${repo}/git/refs/heads/${useBranch}`, { sha, force: Boolean(force) });
        } else {
          await api(token, 'POST', `/repos/${realOwner}/${repo}/git/refs`, { ref: `refs/heads/${useBranch}`, sha });
        }
      } catch (e) {
        if (force && parent) {
          await api(token, 'PATCH', `/repos/${realOwner}/${repo}/git/refs/heads/${useBranch}`, { sha, force: true });
        } else throw e;
      }
      onProgress(`GitHub ready: ${url}`);
      return { ok: true, url, owner: realOwner, repo, branch: useBranch, sha, method: 'api' };
    } finally {
      await fs.rm(work, { recursive: true, force: true }).catch(() => {});
    }
  } catch (err) {
    return fail(err);
  }
}

export { explainGitHubError, formatUserFacingError };
export default { publishSourceToGitHub, explainGitHubError, formatUserFacingError };
