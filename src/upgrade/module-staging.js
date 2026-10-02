import fs from 'node:fs/promises';
import path from 'node:path';
import { listFiles } from '../utils/fsx.js';
import { sourceFingerprint, sourceManifest, diffSourceManifest } from '../projects/source-version.js';
import { isProtectedFilePath } from '../security/policy.js';

export async function stageUpgradeModule({ project, sourceDir, snapshots, modulesRoot, pack, jobId, emit = () => {} }) {
  if (!['ai', 'feedback'].includes(pack)) throw new Error(`Unsupported Upgrade module: ${pack}`);
  const moduleRoot = path.resolve(modulesRoot, pack === 'ai' ? 'ai-app-kernel' : 'feedback');
  if (!moduleRoot.startsWith(path.resolve(modulesRoot) + path.sep)) throw new Error('Unsafe module source path.');
  const moduleStat = await fs.stat(moduleRoot);
  if (!moduleStat.isDirectory()) throw new Error(`Upgrade module source is not a directory: ${pack}`);
  const sourceFiles = pack === 'ai' ? await listFiles(moduleRoot) : ['shfh-client.js'];
  if (!sourceFiles.length) throw new Error(`Upgrade module source is empty: ${pack}`);
  const destinations = pack === 'ai'
    ? sourceFiles.map((file) => [`vendor/ai-app-kernel/${file}`, path.join(moduleRoot, file)])
    : [
      ['vendor/feedback/shfh-client.js', path.join(moduleRoot, 'shfh-client.js')],
      ['public/shfh-client.js', path.join(moduleRoot, 'shfh-client.js')],
    ];
  const beforeHash = await sourceFingerprint(sourceDir);
  const beforeManifest = await sourceManifest(sourceDir);
  const checkpoint = await snapshots.create(project, `before-module-${pack}-${String(jobId || '').slice(0, 8)}`);
  const checkpointHash = await sourceFingerprint(checkpoint.path);
  if (checkpointHash !== beforeHash) throw new Error('Module staging stopped because its rollback snapshot did not match the source.');
  const changedFiles = [];
  let totalBytes = 0;
  emit('module', 'running', `📦 Staging the ${pack === 'ai' ? 'AI Kernel' : 'Feedback'} module inside the Upgrade checkpoint…`);
  try {
    for (const [relative, from] of destinations) {
      const normalized = relative.replace(/\\/g, '/');
      if (isProtectedFilePath(normalized)) {
        const error = new Error(`Protected module target rejected: ${normalized}`);
        error.code = 'PATCH_PROTECTED_FILE';
        throw error;
      }
      const target = path.resolve(sourceDir, ...normalized.split('/'));
      const root = path.resolve(sourceDir);
      if (!target.startsWith(root + path.sep)) throw new Error(`Unsafe module target: ${normalized}`);
      let parent = root;
      for (const part of normalized.split('/').slice(0, -1)) {
        parent = path.join(parent, part);
        try {
          const stat = await fs.lstat(parent);
          if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe module target directory: ${normalized}`);
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
        }
      }
      const fromStat = await fs.lstat(from);
      if (!fromStat.isFile() || fromStat.isSymbolicLink()) throw new Error(`Unsafe module source asset: ${normalized}`);
      if (fromStat.size > 5 * 1024 * 1024) throw new Error(`Module asset is too large to stage safely: ${normalized}`);
      const contents = await fs.readFile(from);
      totalBytes += contents.length;
      if (totalBytes > 20 * 1024 * 1024) throw new Error('Module pack exceeds the safe staging size limit.');
      try {
        const current = await fs.lstat(target);
        if (current.isSymbolicLink() || !current.isFile()) throw new Error(`Module target is not a regular file: ${normalized}`);
        if (!(await fs.readFile(target)).equals(contents)) {
          const error = new Error(`Module target already contains different user code: ${normalized}`);
          error.code = 'NEEDS_USER_ACTION';
          throw error;
        }
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, contents, { flag: 'wx' });
        changedFiles.push(normalized);
      }
    }
    const afterManifest = await sourceManifest(sourceDir);
    const actualChangedFiles = diffSourceManifest(beforeManifest, afterManifest);
    const expectedChangedFiles = [...changedFiles].sort();
    if (actualChangedFiles.join('\n') !== expectedChangedFiles.join('\n')) {
      throw new Error(`Module staging changed files outside its manifest: ${actualChangedFiles.join(', ')}`);
    }
    return {
      pack,
      snapshotId: checkpoint.id,
      beforeHash,
      afterHash: await sourceFingerprint(sourceDir),
      changedFiles: actualChangedFiles,
    };
  } catch (err) {
    await snapshots.restore(project, checkpoint.id);
    const restoredHash = await sourceFingerprint(sourceDir);
    if (restoredHash !== beforeHash) throw new Error(`${String(err.message || err)}; module staging rollback could not be verified.`);
    err.moduleStage = {
      pack,
      snapshotId: checkpoint.id,
      beforeHash,
      afterHash: restoredHash,
      proposedFiles: destinations.map(([relative]) => relative.replace(/\\/g, '/')),
      changedFiles,
      rollbackVerified: true,
    };
    throw err;
  }
}

export async function rollbackUpgradeModule({ project, sourceDir, snapshots, stage, reason }) {
  const currentHash = await sourceFingerprint(sourceDir);
  if (currentHash === stage.beforeHash) return { ...stage, terminalState: 'NO_CHANGE', reason };
  await snapshots.restore(project, stage.snapshotId);
  const restoredHash = await sourceFingerprint(sourceDir);
  const verified = restoredHash === stage.beforeHash;
  const result = { ...stage, restoredHash, rollbackVerified: verified, terminalState: verified ? 'ROLLED_BACK' : 'FAILED', reason };
  if (!verified) throw new Error(`Module staging rollback failed verification (${reason}).`);
  return result;
}
