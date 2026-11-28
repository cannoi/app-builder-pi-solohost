/**
 * Runtime / validation tools (v1.10.0, M2). Child-process mode through the controlled executor.
 * Apps run from a temp copy and are tracked by id; exec.stop_app (or process exit) always cleans up.
 */
import { STATUS } from '../../validation/status.js';
import { runValidationPipeline } from '../../validation/pipeline.js';
import { startApp, probeHealth, probeRoutes } from '../../runtime/app-runner.js';
import { inspectRoutes } from '../../intel/routes.js';
import { buildFingerprint } from '../../intel/fingerprint.js';
import { checkImports } from '../../diagnostics/imports.js';

const apps = new Map();
let seq = 0;

export function runningAppIds() { return [...apps.keys()]; }
export async function stopAllToolApps() { for (const [id, a] of apps) { apps.delete(id); await a.stop().catch(() => {}); } }

export function registerRuntimeTools(registry) {
  const needSrc = (ctx) => {
    const d = ctx?.sourceDir || ctx?.projectSourceDir;
    if (!d) throw new Error('sourceDir required');
    return d;
  };
  const appArg = { type: 'object', properties: { appId: { type: 'string', pattern: '^app_[0-9]+$' } }, required: ['appId'], additionalProperties: false };
  const getApp = (args) => {
    const a = apps.get(args.appId);
    if (!a) throw new Error(`unknown appId ${args.appId}`);
    return a;
  };

  registry.register({
    id: 'code.imports',
    name: 'Import check',
    description: 'Finds broken relative imports, missing ESM extensions and wrong letter case (file:line).',
    category: 'code',
    permission: 'READ',
    mode: 'in_process',
    timeoutMs: 20_000,
    input: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (_a, ctx) => checkImports(needSrc(ctx)),
  });

  registry.register({
    id: 'validation.run',
    name: 'Validation pipeline',
    description: 'Non-mutating validation: static checks; optional runtime boot, HTTP probe and browser QA.',
    category: 'validation',
    permission: 'READ',
    mode: 'child_process',
    timeoutMs: 300_000,
    input: { type: 'object', properties: { runtime: { type: 'boolean' }, browser: { type: 'boolean' }, tests: { type: 'boolean' } }, additionalProperties: false },
    handler: async (args, ctx) => {
      const report = await runValidationPipeline(needSrc(ctx), { runtime: Boolean(args.runtime), browser: Boolean(args.browser), tests: Boolean(args.tests), signal: ctx.signal });
      return { ok: report.ok, status: report.status, data: { status: report.status, score: report.score, summary: report.summaryEn, steps: report.steps.map((s) => ({ id: s.id, status: s.status, message: s.message })), findings: report.findings.slice(0, 30) } };
    },
  });

  registry.register({
    id: 'exec.start_app',
    name: 'Start app',
    description: 'Boots the app from a temp copy on an ephemeral PORT; returns appId and baseUrl.',
    category: 'runtime',
    permission: 'EXEC_SAFE',
    mode: 'child_process',
    timeoutMs: 90_000,
    input: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (_a, ctx) => {
      const dir = needSrc(ctx);
      const fp = await buildFingerprint(dir);
      const r = await startApp(dir, { fingerprint: fp.data || {}, signal: ctx.signal });
      if (!r.app) return { ok: false, status: r.status, error: r.message, data: { logs: r.logs || '', classification: r.classification || null } };
      seq += 1;
      const appId = `app_${seq}`;
      apps.set(appId, { ...r.app, sourceDir: dir });
      return { ok: true, status: STATUS.PASS, data: { appId, baseUrl: r.baseUrl, port: r.port } };
    },
  });

  registry.register({
    id: 'exec.stop_app',
    name: 'Stop app',
    description: 'Stops a started app and its whole process group; removes the temp copy.',
    category: 'runtime',
    permission: 'EXEC_SAFE',
    mode: 'child_process',
    timeoutMs: 15_000,
    input: appArg,
    handler: async (args) => {
      const a = getApp(args);
      apps.delete(args.appId);
      const s = await a.stop();
      return { ok: !s.alive, status: s.alive ? STATUS.FAIL : STATUS.PASS, data: s };
    },
  });

  registry.register({
    id: 'exec.health_check',
    name: 'Health check',
    description: 'GET /health (or /api/health) on a started app; expects 2xx.',
    category: 'runtime',
    permission: 'NETWORK_LOCAL',
    mode: 'in_process',
    timeoutMs: 20_000,
    input: appArg,
    handler: async (args) => {
      const a = getApp(args);
      const routes = (await inspectRoutes(a.sourceDir)).data?.routes || [];
      const r = await probeHealth(a.baseUrl, { routes });
      return { ok: r.status !== STATUS.FAIL, status: r.status, data: r.evidence, error: r.status === STATUS.PASS ? undefined : r.message };
    },
  });

  registry.register({
    id: 'test.api_smoke',
    name: 'API smoke test',
    description: 'GET every safe declared route and client-referenced API/asset on a started app.',
    category: 'runtime',
    permission: 'NETWORK_LOCAL',
    mode: 'in_process',
    timeoutMs: 60_000,
    input: appArg,
    handler: async (args) => {
      const a = getApp(args);
      const intel = (await inspectRoutes(a.sourceDir)).data || {};
      const r = await probeRoutes(a.baseUrl, { serverRoutes: intel.serverRoutes || [], clientCalls: intel.clientCalls || [] });
      return { ok: r.status !== STATUS.FAIL, status: r.status, data: r.evidence, error: r.status === STATUS.FAIL ? r.message : undefined };
    },
  });

  registry.register({
    id: 'exec.logs',
    name: 'App logs',
    description: 'Redacted stdout/stderr tail of a started app.',
    category: 'runtime',
    permission: 'EXEC_SAFE',
    mode: 'in_process',
    timeoutMs: 5_000,
    input: appArg,
    handler: async (args) => {
      const a = getApp(args);
      return { ok: true, status: STATUS.PASS, data: { ...a.handle.logs(), exited: a.handle.exited } };
    },
  });
}
