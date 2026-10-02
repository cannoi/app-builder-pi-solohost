import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { importZipBuffer } from '../projects/importer.js';
import { sourceFingerprint } from '../projects/source-version.js';
import { createRepairOperation, finishRepairOperation, persistRepairOperation, transitionRepairOperation } from '../jobs/loop-guard.js';

export function resolveUpgradeRepository(source = {}, release = {}, pending = {}) {
  source ||= {};
  release ||= {};
  pending ||= {};
  const pushed = release.github || release;
  const owner = source.owner || pending.owner || pushed.owner;
  const repo = source.repo || pending.repo || pushed.repo;
  if (!owner || !repo) return null;
  return {
    type: 'github',
    owner: String(owner),
    repo: String(repo),
    url: source.url || pending.githubUrl || pushed.url || `https://github.com/${owner}/${repo}`,
    branch: source.branch || pending.branch || pushed.branch || null,
    lastSyncedCommit: source.lastSyncedCommit || null,
  };
}

export async function refreshUpgradeSource({ project, projects, snapshots, github, source, fetchedSource = null, jobId = null, emit = () => {} }) {
  const repository = resolveUpgradeRepository(source);
  const operation = createRepairOperation({ jobId, projectId: project.id, kind: 'upgrade-source-sync' });
  const sourceDir = projects.sourceDir(project.slug);
  const beforeHash = await sourceFingerprint(sourceDir);
  operation.workspace_hash_before = beforeHash;
  await persistRepairOperation(projects, project, operation);
  let snapshot = null;
  let staging = null;
  let backup = null;
  let swapped = false;
  let preserveBackup = false;
  try {
    if (!repository) {
      const error = new Error('NEEDS_USER_ACTION: Link this project to its GitHub repository before upgrading. The local copy was not used as a substitute for the GitHub source of truth.');
      error.code = 'UPGRADE_SOURCE_UNLINKED';
      throw error;
    }
    transitionRepairOperation(operation, 'INSPECTING', { repository: `${repository.owner}/${repository.repo}` });
    emit('inspecting', 'running', `Fetching the current GitHub source for ${repository.owner}/${repository.repo}…`);
    const remote = fetchedSource || await github.fetchRepositorySource(repository.owner, repository.repo);
    if (!remote?.archive || !/^[a-f0-9]{40}$/i.test(String(remote.commitSha || ''))) {
      throw new Error('GitHub source fetch did not provide a pinned commit archive.');
    }
    const projectDir = projects.projectDir(project);
    staging = path.join(projectDir, `.upgrade-source-${crypto.randomUUID()}`);
    backup = path.join(projectDir, `.upgrade-source-backup-${crypto.randomUUID()}`);
    await fs.mkdir(staging, { recursive: true });
    await importZipBuffer(remote.archive, staging, { replace: true });
    if (!(await readManifest(staging)).size) throw new Error('GitHub source archive contained no application files.');
    const stagedHash = await sourceFingerprint(staging);
    const beforeSnapshot = await sourceFingerprint(sourceDir);
    if (beforeSnapshot !== beforeHash) {
      const error = new Error('Project source changed while GitHub was being fetched; no source was replaced.');
      error.code = 'UPGRADE_SOURCE_CHANGED';
      throw error;
    }
    snapshot = await snapshots.create(project, 'before-upgrade-github-sync');
    const snapshotHash = await sourceFingerprint(snapshot.path);
    if (snapshotHash !== beforeHash) {
      const error = new Error('The pre-sync snapshot does not match the current source; GitHub sync was stopped.');
      error.code = 'UPGRADE_SOURCE_CHANGED';
      throw error;
    }
    transitionRepairOperation(operation, 'BASELINE', {
      github_commit: remote.commitSha,
      before_hash: beforeHash,
      snapshot_id: snapshot.id,
      snapshot_hash: snapshotHash,
    });
    emit('baseline', 'running', `Saved a rollback snapshot before syncing commit ${remote.commitSha.slice(0, 12)}…`);
    await fs.rename(sourceDir, backup);
    swapped = true;
    await fs.rename(staging, sourceDir);
    staging = null;
    const afterHash = await sourceFingerprint(sourceDir);
    if (afterHash !== stagedHash) throw new Error('The installed source hash does not match the downloaded GitHub archive.');
    const changedFiles = await diffFiles(snapshot.path, sourceDir);
    const record = {
      type: 'github',
      owner: remote.owner || repository.owner,
      repo: remote.repo || repository.repo,
      url: remote.url || repository.url,
      branch: remote.branch || repository.branch,
      commitSha: remote.commitSha,
      lastSyncedCommit: remote.commitSha,
      fetchedAt: remote.fetchedAt || new Date().toISOString(),
      lastSyncedAt: new Date().toISOString(),
      sourceHash: afterHash,
      previousSourceHash: beforeHash,
      snapshotId: snapshot.id,
    };
    await projects.saveMetadata(project, 'upgrade-source.json', record);
    operation.workspace_hash_after = afterHash;
    operation.actual_changed_files = changedFiles;
    operation.proposed_files = [];
    finishRepairOperation(operation, changedFiles.length ? 'DONE' : 'NO_CHANGE', {
      github_commit: remote.commitSha,
      changed_files: changedFiles,
      workspace_hash_before: beforeHash,
      workspace_hash_after: afterHash,
      snapshot_id: snapshot.id,
      source_hash: afterHash,
    });
    await persistRepairOperation(projects, project, operation);
    await fs.rm(backup, { recursive: true, force: true }).catch(() => {});
    backup = null;
    emit('baseline', 'done', `GitHub commit ${remote.commitSha.slice(0, 12)} is now the verified source baseline.`);
    return { source: record, changedFiles, beforeHash, sourceHash: afterHash, snapshotId: snapshot.id, operationId: operation.operation_id };
  } catch (err) {
    if (swapped && snapshot) {
      try {
        await snapshots.restore(project, snapshot.id);
        const restoredHash = await sourceFingerprint(sourceDir);
        operation.rollback = { expected_hash: beforeHash, restored_hash: restoredHash, verified: restoredHash === beforeHash, snapshot_id: snapshot.id };
        if (!operation.rollback.verified) throw new Error('Source rollback hash verification failed.');
      } catch (rollbackError) {
        preserveBackup = true;
        err.message = `${String(err.message || err)}; GitHub source rollback failed: ${String(rollbackError.message || rollbackError)}`;
      }
    }
    const terminalState = err.code === 'UPGRADE_SOURCE_UNLINKED' ? 'NEEDS_USER_ACTION'
      : err.code === 'UPGRADE_SOURCE_CHANGED' ? 'NEEDS_USER_ACTION'
        : operation.rollback?.verified ? 'ROLLED_BACK' : 'FAILED';
    finishRepairOperation(operation, terminalState, {
      error: err.message || String(err),
      workspace_hash_after: await sourceFingerprint(sourceDir).catch(() => null),
      rollback: operation.rollback || null,
    });
    await persistRepairOperation(projects, project, operation);
    err.operationId = operation.operation_id;
    err.terminalState = terminalState;
    throw err;
  } finally {
    if (staging) await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    if (backup && !preserveBackup) await fs.rm(backup, { recursive: true, force: true }).catch(() => {});
  }
}

async function diffFiles(beforeDir, afterDir) {
  const [before, after] = await Promise.all([readManifest(beforeDir), readManifest(afterDir)]);
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((file) => before.get(file) !== after.get(file)).sort();
}

async function readManifest(root, prefix = '') {
  const entries = await fs.readdir(path.join(root, prefix), { withFileTypes: true }).catch(() => []);
  const files = new Map();
  for (const entry of entries) {
    if (entry.isDirectory() && ['node_modules', '.git'].includes(entry.name)) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(root, relative);
    if (entry.isDirectory()) {
      for (const [file, hash] of await readManifest(root, relative)) files.set(file, hash);
    } else if (entry.isFile()) {
      files.set(relative.replace(/\\/g, '/'), crypto.createHash('sha256').update(await fs.readFile(full)).digest('hex'));
    }
  }
  return files;
}
