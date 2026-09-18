import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const OWNED = /^(paf-app:|paf-sandbox:|pi-app-factory-test:)/;

export async function gcDocker({ keepImage = null, keepContainer = null, log } = {}) {
  const removed = { containers: [], images: [] };
  try {
    const { stdout: cs } = await exec('docker', ['ps', '-a', '--format', '{{.ID}} {{.Names}} {{.Status}}'], { timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
    for (const line of String(cs).trim().split('\n').filter(Boolean)) {
      const [id, name, ...rest] = line.split(' ');
      const status = rest.join(' ');
      if (!name?.startsWith('paf-app-') && !name?.startsWith('paf-sandbox-') && !name?.startsWith('paf-')) continue;
      if (keepContainer && (name === keepContainer || id.startsWith(keepContainer))) continue;
      if (/up/i.test(status) && name === keepContainer) continue;
      if (/up/i.test(status) && name.startsWith('paf-app-') && name !== keepContainer) {
        await exec('docker', ['rm', '-f', name], { timeout: 15000 }).catch(() => {});
        removed.containers.push(name);
        continue;
      }
      if (!/up/i.test(status)) {
        await exec('docker', ['rm', '-f', name], { timeout: 15000 }).catch(() => {});
        removed.containers.push(name);
      }
    }
  } catch (err) {
    log?.warn?.('container gc skipped', { error: String(err.message || err) });
  }

  try {
    const { stdout: imgs } = await exec('docker', ['images', '--format', '{{.ID}} {{.Repository}}:{{.Tag}} {{.CreatedSince}}'], { timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
    for (const line of String(imgs).trim().split('\n').filter(Boolean)) {
      const [id, ref] = line.split(' ');
      if (keepImage && (ref === keepImage || id === keepImage)) continue;
      if (OWNED.test(ref) && ref !== keepImage) {
        await exec('docker', ['rmi', '-f', ref], { timeout: 20000 }).catch(() => {});
        removed.images.push(ref);
      }
    }
    const { stdout: dangling } = await exec('docker', ['images', '-f', 'dangling=true', '--format', '{{.ID}} {{.CreatedSince}}'], { timeout: 15000 }).catch(() => ({ stdout: '' }));
    for (const line of String(dangling).trim().split('\n').filter(Boolean)) {
      const [id, age] = line.split(' ');
      if (!id) continue;
      if (/year|month|week/.test(age || '')) continue;
      await exec('docker', ['rmi', '-f', id], { timeout: 20000 }).catch(() => {});
      removed.images.push(id);
    }
  } catch (err) {
    log?.warn?.('image gc skipped', { error: String(err.message || err) });
  }
  return removed;
}

export async function reapIdlePreviews({ projects, runner, idleMs = 15 * 60 * 1000, log } = {}) {
  if (!projects || !runner) return { stopped: [] };
  const stopped = [];
  const now = Date.now();
  for (const project of projects.list()) {
    const runtime = await projects.readMetadata(project, 'runtime.json', {}).catch(() => ({}));
    if (runtime.status !== 'passed') continue;
    const seen = Date.parse(runtime.lastSeenAt || runtime.updatedAt || runtime.stoppedAt || 0);
    if (!seen || now - seen < idleMs) continue;
    await runner.stopApp({ projectSlug: project.slug, removeImage: true }).catch((err) => log?.warn?.('idle stop failed', { error: String(err.message || err) }));
    await projects.saveMetadata(project, 'runtime.json', {
      ...runtime,
      status: 'stopped',
      stoppedAt: new Date().toISOString(),
      reason: 'idle-timeout',
    }).catch(() => {});
    stopped.push(project.slug);
  }
  return { stopped };
}
