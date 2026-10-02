import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GitHubManager } from '../src/github/manager.js';
import { refreshUpgradeSource, resolveUpgradeRepository } from '../src/upgrade/source.js';
import { sourceFingerprint } from '../src/projects/source-version.js';
import { packZip } from '../src/utils/zip.js';

function sourceProject(root) {
  const metadata = new Map();
  const project = { id: 'github-source-project', slug: 'github-source', name: 'GitHub Source' };
  return {
    project,
    projects: {
      sourceDir: () => path.join(root, 'source'),
      projectDir: () => root,
      async saveMetadata(_project, name, value) { metadata.set(name, value); },
      async readMetadata(_project, name, fallback = null) { return metadata.has(name) ? metadata.get(name) : fallback; },
    },
    metadata,
  };
}

function snapshotStore(root) {
  let id = 0;
  const backups = new Map();
  return {
    async create() {
      const snapshotId = `snapshot-${++id}`;
      const snapshotPath = path.join(root, snapshotId);
      await fs.cp(path.join(root, 'source'), snapshotPath, { recursive: true });
      backups.set(snapshotId, snapshotPath);
      return { id: snapshotId, path: snapshotPath };
    },
    async restore(_project, snapshotId) {
      await fs.rm(path.join(root, 'source'), { recursive: true, force: true });
      await fs.cp(backups.get(snapshotId), path.join(root, 'source'), { recursive: true });
    },
  };
}

async function archiveOf(entries) {
  return packZip(entries.map(([name, data]) => ({ name: `repo-root/${name}`, data })));
}

test('GitHub source fetch pins the archive to the current default-branch commit', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const sha = 'a'.repeat(40);
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/repos/alice/demo')) {
      return Response.json({ default_branch: 'stable', owner: { login: 'alice' }, name: 'demo', html_url: 'https://github.com/alice/demo' });
    }
    if (String(url).endsWith('/repos/alice/demo/commits/stable')) return Response.json({ sha });
    if (String(url).endsWith(`/repos/alice/demo/zipball/${sha}`)) return new Response(Buffer.from('zip archive'));
    throw new Error(`Unexpected GitHub request: ${url}`);
  };
  try {
    const github = new GitHubManager({ cfg: { github: { token: 'test-token' } }, log: { warn() {} } });
    const result = await github.fetchRepositorySource('alice', 'demo');
    assert.equal(result.branch, 'stable');
    assert.equal(result.commitSha, sha);
    assert.equal(result.archive.toString(), 'zip archive');
    assert.equal(calls.at(-1).options.headers.Authorization, 'Bearer test-token');
    assert.ok(calls.at(-1).url.endsWith(`/zipball/${sha}`));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Upgrade source sync replaces stale local files with the pinned GitHub tree and records evidence', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-upgrade-github-source-'));
  const { project, projects, metadata } = sourceProject(root);
  const snapshots = snapshotStore(root);
  await fs.mkdir(projects.sourceDir(), { recursive: true });
  await fs.writeFile(path.join(projects.sourceDir(), 'old.txt'), 'stale local file');
  const archive = await archiveOf([['index.html', '<h1>From GitHub</h1>'], ['.env.example', 'PUBLIC_URL=\n']]);
  const stages = [];
  try {
    const result = await refreshUpgradeSource({
      project, projects, snapshots, source: { owner: 'alice', repo: 'demo' },
      github: { async fetchRepositorySource() {
        return { archive, owner: 'alice', repo: 'demo', url: 'https://github.com/alice/demo', branch: 'main', commitSha: 'b'.repeat(40) };
      } },
      emit(stage) { stages.push(stage); },
    });
    assert.equal(await fs.readFile(path.join(projects.sourceDir(), 'index.html'), 'utf8'), '<h1>From GitHub</h1>');
    await assert.rejects(() => fs.access(path.join(projects.sourceDir(), 'old.txt')), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(projects.sourceDir(), '.env.example'), 'utf8'), 'PUBLIC_URL=\n');
    assert.equal(result.source.commitSha, 'b'.repeat(40));
    assert.equal(result.source.sourceHash, await sourceFingerprint(projects.sourceDir()));
    assert.equal(metadata.get('upgrade-source.json').snapshotId, result.snapshotId);
    const operations = metadata.get('repair-operations.json');
    assert.equal(operations.at(-1).kind, 'upgrade-source-sync');
    assert.equal(operations.at(-1).terminal_state, 'DONE');
    assert.deepEqual(operations.at(-1).actual_changed_files, ['.env.example', 'index.html', 'old.txt']);
    assert.ok(stages.includes('baseline'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Upgrade source sync rolls back when the archive cannot be unpacked', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-upgrade-github-rollback-'));
  const { project, projects, metadata } = sourceProject(root);
  await fs.mkdir(projects.sourceDir(), { recursive: true });
  const original = 'keep existing source';
  await fs.writeFile(path.join(projects.sourceDir(), 'index.html'), original);
  try {
    await assert.rejects(() => refreshUpgradeSource({
      project, projects, snapshots: snapshotStore(root),
      source: { owner: 'alice', repo: 'demo' },
      github: { async fetchRepositorySource() {
        return { archive: Buffer.from('not a zip'), commitSha: 'c'.repeat(40) };
      } },
    }), /contained no application files/);
    assert.equal(await fs.readFile(path.join(projects.sourceDir(), 'index.html'), 'utf8'), original);
    assert.equal(metadata.get('repair-operations.json').at(-1).terminal_state, 'FAILED');
    assert.equal(await sourceFingerprint(projects.sourceDir()), metadata.get('repair-operations.json').at(-1).workspace_hash_before);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Upgrade does not substitute an unlinked local folder for GitHub source', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-upgrade-unlinked-'));
  const { project, projects, metadata } = sourceProject(root);
  await fs.mkdir(projects.sourceDir(), { recursive: true });
  await fs.writeFile(path.join(projects.sourceDir(), 'index.html'), '<h1>Local</h1>');
  try {
    await assert.rejects(() => refreshUpgradeSource({
      project, projects, snapshots: snapshotStore(root), github: {}, source: null,
    }), (error) => error.code === 'UPGRADE_SOURCE_UNLINKED' && error.terminalState === 'NEEDS_USER_ACTION');
    assert.equal(await fs.readFile(path.join(projects.sourceDir(), 'index.html'), 'utf8'), '<h1>Local</h1>');
    assert.equal(metadata.get('repair-operations.json').at(-1).terminal_state, 'NEEDS_USER_ACTION');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Upgrade repository resolution supports previously published project metadata', () => {
  assert.deepEqual(resolveUpgradeRepository({}, { github: { owner: 'alice', repo: 'demo', url: 'https://github.com/alice/demo' } }), {
    type: 'github', owner: 'alice', repo: 'demo', url: 'https://github.com/alice/demo', branch: null, lastSyncedCommit: null,
  });
});
