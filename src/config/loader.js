export function loadConfig() {
  const config = {
    port: Number(process.env.PORT || 8080),
    bind: process.env.FACTORY_BIND || process.env.BIND || '0.0.0.0',
    dataDir: process.env.DATA_DIR || './data',
    workspaceDir: process.env.WORKSPACE_DIR || './workspace',
    projectsDir: process.env.PROJECTS_DIR || './projects',
    templatesDir: process.env.TEMPLATES_DIR || './templates',
    logLevel: process.env.LOG_LEVEL || 'info',
    locale: process.env.APP_LOCALE || 'en',
    version: '1.4.27',
    runtime: {
      mode: process.env.PREVIEW_MODE || 'auto',
      podman: { apiUrl: process.env.PODMAN_API_URL || process.env.SANDBOX_PODMAN_API_URL || process.env.CONTAINER_SANDBOX_PODMAN_API_URL || '' },
    },
    preview: {
      requireInternet: String(process.env.PREVIEW_REQUIRE_INTERNET || 'true').toLowerCase() === 'true',
      requireBrowserTest: String(process.env.PREVIEW_REQUIRE_BROWSER_TEST || 'true').toLowerCase() === 'true',
    },
    ai: {
      provider: ['gemini', 'deepseek'].includes(String(process.env.AI_PROVIDER || 'deepseek').toLowerCase()) ? String(process.env.AI_PROVIDER || 'deepseek').toLowerCase() : 'deepseek',
      mode: (process.env.AI_MODE || 'single').toLowerCase() === 'council' ? 'council' : 'single',
      geminiKey: process.env.GEMINI_API_KEY || '',
      geminiModel: process.env.GEMINI_MODEL || '',
      deepseekKey: process.env.DEEPSEEK_API_KEY || '',
      deepseekModel: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
    },
    github: {
      token: process.env.GITHUB_TOKEN || '',
      owner: process.env.GITHUB_OWNER || '',
      defaultVisibility: process.env.GITHUB_DEFAULT_VISIBILITY || 'private',
    },
    limits: {
      buildTimeoutSec: Number(process.env.BUILD_TIMEOUT || 900),
      sandboxTimeoutSec: Number(process.env.SANDBOX_TIMEOUT || 300),
      maxAutoFixes: Number(process.env.MAX_AUTO_FIXES || 3),
      maxConcurrentBuilds: Number(process.env.MAX_CONCURRENT_BUILDS || 1),
      maxProjectSizeMb: Number(process.env.MAX_PROJECT_SIZE_MB || 80),
      maxLogSizeMb: Number(process.env.MAX_LOG_SIZE_MB || 10),
    },
  };
  return config;
}

export function publicConfig(cfg) {
  return {
    version: cfg.version,
    bind: cfg.bind,
    locale: cfg.locale,
    engine: { provider: cfg.runtime?.podman?.apiUrl ? 'podman-api' : 'native-preview', mode: cfg.runtime?.mode || 'auto', configured: true, containerSandbox: Boolean(cfg.runtime?.podman?.apiUrl), dockerSocket: false },
    ai: { provider: cfg.ai.provider, mode: cfg.ai.mode, geminiConfigured: Boolean(cfg.ai.geminiKey), deepseekConfigured: Boolean(cfg.ai.deepseekKey), deepseekModel: cfg.ai.deepseekModel },
    github: { configured: Boolean(cfg.github.token && cfg.github.owner), owner: cfg.github.owner || null },
  };
}
