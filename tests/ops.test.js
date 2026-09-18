import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { inferAction, classifyLogs, isHostDockerCommand, isNpmOnEmptyRisk } from '../src/scripts/ops.js';

test('user language maps to controller scripts', () => {
  assert.equal(inferAction('chạy app và cho tôi link'), 'run');
  assert.equal(inferAction('app bị lỗi hãy sửa'), 'improve');
  assert.equal(inferAction('quét bảo mật'), 'analyze');
});

test('natural-language problems route to debugging and access errors get concrete causes', () => {
  assert.equal(inferAction('GitHub upload failed because workflow permission is read only'), 'improve');
  assert.equal(inferAction('the app has a problem and does not work'), 'improve');
  assert.equal(classifyLogs('docker compose up -d failed: ghcr.io/example/app:0.1.0 Error response from daemon: unauthorized').code, 'registry_unauthorized');
  assert.equal(classifyLogs('GitHub workflow permission is read-only').code, 'github_workflow_permission');
});

test('crash logs are classified instead of ignored', () => {
  const crash = classifyLogs("Error: Cannot find module 'express'");
  assert.equal(crash.code, 'missing_express');
  assert.match(crash.title, /before listen/);
});

test('raw docker and npm commands are treated as host scripts', () => {
  assert.equal(isHostDockerCommand('docker build -t paf-app:ran-san-moi .'), true);
  assert.equal(isNpmOnEmptyRisk('npm install'), true);
});


test('GitHub publishing uses the current remote head and never force-updates main', async () => {
  const github = await import('../src/github/manager.js');
  assert.equal(github.buildGitTreeUpdates([{ path: 'new.txt', sha: 'abc' }], [{ path: 'old.txt', sha: 'def', type: 'blob' }])[1].sha, null);
  const source = fs.readFileSync(new URL('../src/github/manager.js', import.meta.url), 'utf8');
  assert.match(source, /force:\s*false/);
  assert.match(source, /verifyPublishedFiles/);
});


test('export intent routes to an export action', async () => {
  const { inferAction } = await import('../src/scripts/ops.js');
  assert.equal(inferAction('give me a ZIP download of this app'), 'export');
  assert.equal(inferAction('cho tôi file cài đặt SoloHost'), 'export');
});


test('GitHub publish creates a parent-aware commit, deletes stale files, and verifies the remote tree', async () => {
  const { GitHubManager, gitBlobSha } = await import('../src/github/manager.js');
  const root = '/tmp/paf-github-publish-test';
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(`${root}/new.txt`, 'hello');
  fs.writeFileSync(`${root}/Dockerfile`, 'FROM node:24-alpine\nCOPY . .\nCMD ["node","index.js"]\n');
  fs.writeFileSync(`${root}/index.js`, 'console.log("ok")');
  const localSha = gitBlobSha(Buffer.from('hello'));
  const mgr = new GitHubManager({ cfg: { github: { token: 'test', owner: 'alice' } }, log: { warn() {} } });
  let head = 'oldcommit';
  let commitBody = null;
  let treeBody = null;
  let refBody = null;
  mgr.ensureRepo = async () => ({ html_url: 'https://github.com/alice/demo', default_branch: 'main' });
  const published = [];
  mgr.api = async (method, pathname, body) => {
    if (method === 'POST' && pathname.endsWith('/git/blobs')) { published.push(true); return { sha: localSha }; }
    if (method === 'GET' && pathname.endsWith('/git/ref/heads/main')) return { object: { sha: head } };
    if (method === 'GET' && pathname.endsWith('/git/commits/oldcommit')) return { tree: { sha: 'basetree' } };
    if (method === 'GET' && pathname.includes('/git/trees/basetree')) return { tree: [{ path: 'old.txt', type: 'blob', sha: 'oldsha' }] };
    if (method === 'POST' && pathname.endsWith('/git/trees')) { treeBody = body; return { sha: 'newtree' }; }
    if (method === 'POST' && pathname.endsWith('/git/commits')) { commitBody = body; head = 'newcommit'; return { sha: 'newcommit' }; }
    if (method === 'PATCH' && pathname.endsWith('/git/refs/heads/main')) { refBody = body; return {}; }
    if (method === 'GET' && pathname.endsWith('/git/commits/newcommit')) return { tree: { sha: 'newtree' } };
    if (method === 'GET' && pathname.includes('/git/trees/newtree')) {
      return { tree: ['new.txt', 'Dockerfile', 'index.js'].map((path) => ({ path, type: 'blob', sha: localSha })) };
    }
    throw new Error(`unexpected ${method} ${pathname}`);
  };
  const result = await mgr.createAndPush({ slug: 'demo' }, root, { version: '1.0.0' });
  assert.equal(result.verification.ok, true);
  assert.deepEqual(commitBody.parents, ['oldcommit']);
  assert.equal(refBody.force, false);
  assert.equal(treeBody.tree.some((x) => x.path === 'old.txt' && x.sha === null), true);
});

test('GitHub first publish initializes an empty repository without a base tree', async () => {
  const { GitHubManager, classifyGitHubError } = await import('../src/github/manager.js');
  assert.equal(classifyGitHubError(409, 'Git Repository is empty.'), 'empty_repo');
  assert.equal(classifyGitHubError(401, 'Bad credentials'), 'auth');
  const root = '/tmp/paf-github-empty-test';
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(`${root}/Dockerfile`, 'FROM node:24-alpine\nCMD ["node","index.js"]\n');
  fs.writeFileSync(`${root}/index.js`, 'console.log("ok")');
  const mgr = new GitHubManager({ cfg: { github: { token: 'test', owner: 'alice' } }, log: { warn() {} } });
  let treeBody = null;
  let commitBody = null;
  let createdRef = null;
  let head = null;
  mgr.ensureRepo = async () => ({ html_url: 'https://github.com/alice/demo', default_branch: 'main' });
  mgr.api = async (method, pathname, body) => {
    if (method === 'POST' && pathname.endsWith('/git/blobs')) return { sha: 'blobsha' };
    if (method === 'GET' && pathname.endsWith('/git/ref/heads/main')) {
      if (!head) {
        const err = new Error('GitHub 409: Git Repository is empty.');
        err.code = 'empty_repo';
        err.status = 409;
        throw err;
      }
      return { object: { sha: head } };
    }
    if (method === 'GET' && pathname.endsWith('/git/ref/heads/master')) {
      const err = new Error('GitHub 404');
      err.code = 'not_found';
      throw err;
    }
    if (method === 'POST' && pathname.endsWith('/git/trees')) { treeBody = body; return { sha: 'newtree' }; }
    if (method === 'POST' && pathname.endsWith('/git/commits')) { commitBody = body; return { sha: 'firstcommit' }; }
    if (method === 'POST' && pathname.endsWith('/git/refs')) { createdRef = body; head = body.sha; return {}; }
    if (method === 'GET' && pathname.endsWith('/git/commits/firstcommit')) return { tree: { sha: 'newtree' } };
    if (method === 'GET' && pathname.includes('/git/trees/newtree')) {
      return { tree: [{ path: 'Dockerfile', type: 'blob', sha: 'blobsha' }, { path: 'index.js', type: 'blob', sha: 'blobsha' }] };
    }
    throw new Error(`unexpected ${method} ${pathname}`);
  };
  const result = await mgr.createAndPush({ slug: 'demo' }, root, { version: '1.0.0' });
  assert.equal(result.emptyInitialized, true);
  assert.equal(treeBody.base_tree, undefined);
  assert.equal(commitBody.parents, undefined);
  assert.equal(createdRef.ref, 'refs/heads/main');
  assert.equal(result.verification.ok, true);
});

test('GitHub follows a non-main default branch on existing repositories', async () => {
  const { GitHubManager } = await import('../src/github/manager.js');
  const root = '/tmp/paf-github-trunk-test';
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(`${root}/Dockerfile`, 'FROM node:24-alpine\nCMD ["node","index.js"]\n');
  fs.writeFileSync(`${root}/index.js`, 'ok');
  const mgr = new GitHubManager({ cfg: { github: { token: 'test', owner: 'alice' } }, log: { warn() {} } });
  let patched = null;
  let trunkHead = 'oldcommit';
  mgr.ensureRepo = async () => ({ html_url: 'https://github.com/alice/demo', default_branch: 'trunk' });
  mgr.api = async (method, pathname, body) => {
    if (method === 'POST' && pathname.endsWith('/git/blobs')) return { sha: 'blobsha' };
    if (method === 'GET' && pathname.endsWith('/git/ref/heads/trunk')) return { object: { sha: trunkHead } };
    if (method === 'GET' && pathname.endsWith('/git/commits/oldcommit')) return { tree: { sha: 'basetree' } };
    if (method === 'GET' && pathname.includes('/git/trees/basetree')) return { tree: [] };
    if (method === 'POST' && pathname.endsWith('/git/trees')) return { sha: 'newtree' };
    if (method === 'POST' && pathname.endsWith('/git/commits')) return { sha: 'newcommit' };
    if (method === 'PATCH' && pathname.endsWith('/git/refs/heads/trunk')) { patched = body; trunkHead = body.sha; return {}; }
    if (method === 'GET' && pathname.endsWith('/git/commits/newcommit')) return { tree: { sha: 'newtree' } };
    if (method === 'GET' && pathname.includes('/git/trees/newtree')) {
      return { tree: [{ path: 'Dockerfile', type: 'blob', sha: 'blobsha' }, { path: 'index.js', type: 'blob', sha: 'blobsha' }] };
    }
    const err = new Error('GitHub 404'); err.code = 'not_found'; throw err;
  };
  const result = await mgr.createAndPush({ slug: 'demo' }, root);
  assert.equal(result.branch, 'trunk');
  assert.equal(patched.force, false);
});

test('empty generated project is rejected before GitHub upload', async () => {
  const { validateProjectForPublish } = await import('../src/github/manager.js');
  const root = '/tmp/paf-github-blank-test';
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const result = await validateProjectForPublish(root);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /empty|Dockerfile|source/i);
});

test('GitHub publisher validates required SoloHost files', async () => {
  const { validateReleaseProject } = await import('../src/github/git-publisher.js');
  const root = '/tmp/paf-validate-release';
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const missing = await validateReleaseProject(root);
  assert.equal(missing.ok, false);
  fs.writeFileSync(`${root}/Dockerfile`, 'FROM node:24-alpine\nCMD ["node","index.js"]\n');
  fs.writeFileSync(`${root}/docker-compose.yml`, 'services:\n  app:\n    image: demo:1\n');
  fs.writeFileSync(`${root}/index.js`, 'console.log("ok")');
  const ok = await validateReleaseProject(root);
  assert.equal(ok.ok, true);
});

test('publish error classes stop without guessing the owner', async () => {
  const { classifyPublishError } = await import('../src/github/git-publisher.js');
  assert.equal(classifyPublishError({ status: 401, message: 'Bad credentials' }).code, 'auth');
  assert.match(classifyPublishError({ status: 401 }).message, /authorization is required/i);
  assert.equal(classifyPublishError({ status: 403, message: 'Resource not accessible by integration' }).code, 'permission');
  assert.equal(classifyPublishError({ status: 404, message: 'Not Found' }).code, 'not_found');
  assert.equal(classifyPublishError(new Error('git push rejected')).code, 'git_push');
});

test('publish validation blocks secrets and missing Docker files', async () => {
  const { validateReleaseProject } = await import('../src/github/git-publisher.js');
  const root = '/tmp/paf-secret-publish';
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(`${root}/Dockerfile`, 'FROM node:24-alpine\nENV GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwx\n');
  fs.writeFileSync(`${root}/docker-compose.yml`, 'services:\n  app:\n    image: demo:1\n');
  const blocked = await validateReleaseProject(root);
  assert.equal(blocked.ok, false);
});


test('splitUserSteps keeps multi-step requests separate', async () => {
  const { splitUserSteps } = await import('../src/scripts/ops.js');
  const steps = splitUserSteps('Change the button color then run the app');
  assert.equal(steps.length, 2);
});
