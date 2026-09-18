export async function gcDocker() {
  // Kept for API compatibility. The Builder no longer controls a host Docker daemon.
  return { containers: [], images: [], skipped: true, reason: 'native-preview' };
}

export async function reapIdlePreviews({ projects, runner, idleMs = 15 * 60 * 1000, log } = {}) {
  if (!projects || !runner) return { stopped: [] };
  const stopped = [];
  const now = Date.now();
  for (const project of projects.list()) {
    const runtime = await projects.readMetadata(project, 'runtime.json', {}).catch(() => ({}));
    if (runtime.runtime !== 'native-preview' || runtime.status !== 'passed') continue;
    const seen = Date.parse(runtime.lastSeenAt || runtime.updatedAt || 0);
    if (!seen || now - seen < idleMs) continue;
    await runner.stopApp({ projectSlug: project.slug }).catch((err) => log?.warn?.('idle preview stop failed', { error: String(err.message || err) }));
    await projects.saveMetadata(project, 'runtime.json', { ...runtime, status: 'stopped', stoppedAt: new Date().toISOString(), reason: 'idle-timeout' }).catch(() => {});
    stopped.push(project.slug);
  }
  return { stopped };
}
