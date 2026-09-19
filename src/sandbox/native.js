export class Sandbox {
  constructor({ runner }) { this.runner = runner; }
  async run({ project, sourcePath }) {
    const result = await this.runner.runApp({ sourcePath, projectSlug: project.slug, timeout: 180, keepRunning: false });
    return { status: result.status, health: result.health === true, tests: { passed: result.status === 'passed' ? 1 : 0, failed: result.status === 'passed' ? 0 : 1 }, runtime: 'native-preview', previewPath: result.previewPath || null, logs: result.logs || '', error: result.error || null };
  }
}
