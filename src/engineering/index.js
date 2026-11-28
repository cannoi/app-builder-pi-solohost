/**
 * Engineering Toolkit — host-owned, provider-independent.
 * Flag: ENGINEERING_TOOLKIT = off | shadow | on (default shadow).
 */
import { createRegistry } from './registry/registry.js';
import { registerReadTools } from './registry/descriptors/read-tools.js';
import { execControlled, execNamed, isExecutorBusy, executorQueueLength, stopAllApps, liveAppCount } from './executor/exec.js';
import { registerRuntimeTools, stopAllToolApps } from './registry/descriptors/runtime-tools.js';
import { withSourceGuard, sourceManifest, manifestDigest } from './guard.js';
import { buildEvidence, evidenceBlockFor } from './evidence.js';
import { providerTier, tierPolicy } from './orchestrator/provider-tiers.js';
import { runVerifiedRepairLoop } from './orchestrator/repair-loop.js';
import { planDareV2 } from '../dare/engine-v2.js';
import { redactText, redactDeep } from './redact.js';
import { buildFingerprint } from './intel/fingerprint.js';
import { inspectDeps } from './intel/deps.js';
import { inspectRoutes } from './intel/routes.js';
import { inspectEnv } from './intel/env.js';
import { syntaxCheckProject } from './diagnostics/syntax.js';
import { runValidationPipeline } from './validation/pipeline.js';
import { createCheckpoint, diffManifests } from './checkpoints/store.js';
import { planForTask } from './orchestrator/planner.js';
import { runShadowOrchestration } from './orchestrator/orchestrator.js';
import { runBrowserAgent, detectChromium } from './browser/agent.js';
import { runDareCheck } from './diagnostics/dare-bridge.js';
import { getEngineeringMode, isEngineeringEnabled, resolveEngineeringState, setRuntimeEngineeringSettings } from './config.js';
import {
  loadEngineeringContext,
  saveEngineeringContext,
  appendToolCall,
  emptyEngineeringContext,
} from './context/engineering-context.js';
import { STATUS, mergeStatuses, mapLegacyResult, stepResult } from './validation/status.js';
import { evaluateAcceptanceCriteria } from './validation/acceptance.js';
import { formatQualityReport, canClaimWorking, detectReportLocale } from './report.js';

function registerIntelTools(registry) {
  const needSrc = (ctx) => {
    const d = ctx?.sourceDir || ctx?.projectSourceDir;
    if (!d) throw new Error('sourceDir required');
    return d;
  };
  registry.register({
    id: 'intel.fingerprint',
    name: 'Project fingerprint',
    description: 'Deterministic stack/entrypoint/port/Docker fingerprint.',
    category: 'project_intel',
    permission: 'READ',
    mode: 'in_process',
    timeoutMs: 15_000,
    input: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (_a, ctx) => buildFingerprint(needSrc(ctx)),
  });
  registry.register({
    id: 'intel.deps',
    name: 'Dependencies',
    description: 'package.json dependencies, lockfile, scripts.',
    category: 'project_intel',
    permission: 'READ',
    mode: 'in_process',
    timeoutMs: 10_000,
    input: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (_a, ctx) => inspectDeps(needSrc(ctx)),
  });
  registry.register({
    id: 'intel.routes',
    name: 'HTTP routes',
    description: 'Server routes, client fetch/form/asset calls and UNMATCHED client calls (file:line).',
    category: 'project_intel',
    permission: 'READ',
    mode: 'in_process',
    timeoutMs: 10_000,
    input: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (_a, ctx) => inspectRoutes(needSrc(ctx)),
  });
  registry.register({
    id: 'intel.env',
    name: 'Environment usage',
    description: 'process.env reads (file:line) vs .env.example / compose / config_options declarations.',
    category: 'project_intel',
    permission: 'READ',
    mode: 'in_process',
    timeoutMs: 10_000,
    input: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (_a, ctx) => inspectEnv(needSrc(ctx)),
  });
  registry.register({
    id: 'code.syntax_check',
    name: 'Syntax check',
    description: 'node --check on project JS files (bounded).',
    category: 'code',
    permission: 'READ',
    mode: 'child_process',
    timeoutMs: 30_000,
    input: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (_a, ctx) => syntaxCheckProject(needSrc(ctx)),
  });
}

export function createEngineeringToolkit({ cfg = {}, db = null, log = console } = {}) {
  if (db && typeof db.setting === 'function') {
    const saved = db.setting('engineeringSettings', null);
    if (saved) setRuntimeEngineeringSettings(saved);
  }
  let currentState = resolveEngineeringState({ cfg, db });
  const state = () => currentState;
  const registry = createRegistry();
  registerReadTools(registry);
  registerIntelTools(registry);
  registerRuntimeTools(registry);

  return {
    get mode() { return state().mode; },
    get configuredMode() { return state().configuredMode; },
    get source() { return state().source; },
    get reason() { return state().reason; },
    get reasonVi() { return state().reasonVi; },
    get envLocked() { return state().envLocked; },
    get features() { return state().features; },
    get enabled() { return state().mode !== 'off'; },
    get active() { return state().mode === 'on'; },
    refresh() {
      const saved = db && typeof db.setting === 'function' ? db.setting('engineeringSettings', null) : null;
      if (saved) setRuntimeEngineeringSettings(saved);
      currentState = resolveEngineeringState({ cfg, db });
      return currentState;
    },
    resolveState: (detectors = {}) => resolveEngineeringState({ cfg, db, detectors }),
    registry,
    STATUS,
    exec: execControlled,
    execNamed,
    isExecutorBusy,
    executorQueueLength,
    liveAppCount,
    async stopAll() { await stopAllToolApps(); await stopAllApps(); },
    withSourceGuard,
    sourceManifest,
    manifestDigest,
    buildEvidence,
    evidenceBlockFor: (opts) => evidenceBlockFor(opts, cfg),
    providerTier,
    tierPolicy,
    runVerifiedRepairLoop,
    planDareV2,
    redactText,
    redactDeep,
    fingerprint: buildFingerprint,
    inspectDeps,
    inspectRoutes,
    inspectEnv,
    syntaxCheck: syntaxCheckProject,
    validate: runValidationPipeline,
    evaluateAcceptanceCriteria,
    formatQualityReport,
    canClaimWorking,
    detectReportLocale,
    createCheckpoint,
    diffManifests,
    planForTask,
    runShadow: runShadowOrchestration,
    runBrowserAgent,
    detectChromium,
    runDareCheck,
    loadContext: loadEngineeringContext,
    saveContext: saveEngineeringContext,
    appendToolCall,
    emptyContext: emptyEngineeringContext,
    mergeStatuses,
    mapLegacyResult,
    stepResult,
    async health() {
      const st = state();
      return {
        ok: true,
        mode: st.mode,
        configuredMode: st.configuredMode,
        source: st.source,
        reason: st.reason,
        reasonVi: st.reasonVi,
        envLocked: st.envLocked,
        features: st.features,
        checks: st.checks,
        toolCount: registry.size(),
        executorBusy: isExecutorBusy(),
        queue: executorQueueLength(),
        liveApps: liveAppCount(),
        tools: registry.list().map((t) => t.id),
      };
    },
  };
}

export { getEngineeringMode, isEngineeringEnabled, resolveEngineeringState, STATUS };
export default { createEngineeringToolkit };
