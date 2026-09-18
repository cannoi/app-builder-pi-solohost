// Compatibility facade kept for older imports. Preview execution is delegated
// to the current BuildRunner, which uses Container Sandbox (Podman API) when
// configured and falls back to the built-in native preview. No Docker socket is used.
export class Sandbox {
  constructor({ runner }) { this.runner = runner; }
  async run({ project, sourcePath }) {
    const result = await this.runner.runApp({
      sourcePath,
      projectSlug: project.slug,
      timeout: this.runner.cfg?.limits?.sandboxTimeoutSec || 300,
      keepRunning: false,
    });
    return {
      status: result.status,
      health: result.health === true,
      tests: { passed: result.status === 'passed' ? 1 : 0, failed: result.status === 'passed' ? 0 : 1 },
      runtime: result.runtime || 'native-preview',
      previewPath: result.previewPath || null,
      logs: result.logs || '',
      error: result.error || null,
    };
  }
}
