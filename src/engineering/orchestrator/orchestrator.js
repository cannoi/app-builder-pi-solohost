import { planForTask, matchesExpectation, replan } from './planner.js';
import { runValidationPipeline } from '../validation/pipeline.js';
import { STATUS } from '../validation/status.js';
import { withSourceGuard, sourceManifest, manifestDigest } from '../guard.js';

/**
 * Shadow orchestrator (v1.10.0): runs READ/intel/static-validation only, inside a source guard —
 * if anything under the source tree changes, the tree is restored and the run FAILS loudly
 * (SHADOW_MUTATION). Each step has an expectation; mismatches continue / re-plan / stop.
 * Tool calls are budgeted and deduplicated by toolId + args + source manifest hash.
 */
export async function runShadowOrchestration(toolkit, {
  sourceDir,
  taskType = 'improve',
  projects = null,
  project = null,
  runtime = false,
} = {}) {
  return withSourceGuard(sourceDir, async () => {
    const tools = toolkit.registry.list().map((t) => t.id);
    const fp = await toolkit.fingerprint(sourceDir);
    const plan = planForTask(taskType, fp.data || {}, tools);
    const manifestHash = manifestDigest(await sourceManifest(sourceDir));
    const cache = new Map();
    const results = [];
    const replans = [];
    let queue = [...plan.steps];
    let calls = 0;
    let stopped = null;

    while (queue.length) {
      if (calls >= plan.budget.maxToolCalls) { stopped = 'tool-call budget reached'; break; }
      const step = queue.shift();
      calls += 1;
      let r;
      if (step.tool === 'validation.pipeline') {
        const report = await runValidationPipeline(sourceDir, { stopOnFail: false, guard: false, runtime: runtime && !step.args?.staticOnly });
        r = { ...report, tool: step.tool };
        results.push(r);
      } else {
        const out = await toolkit.registry.call(step.tool, step.args || {}, { sourceDir, cache, manifestHash });
        r = { tool: step.tool, ok: out.ok, status: out.status, error: out.error || null, durationMs: out.durationMs, cached: Boolean(out.cached) };
        results.push(r);
      }
      if (matchesExpectation(step, r)) continue;
      if (step.onMismatch === 'stop') { stopped = `${step.tool} returned ${r.status}`; break; }
      if (step.onMismatch === 'replan') {
        const next = replan(queue, step, r);
        replans.push(next.reason);
        queue = next.steps;
      }
    }

    const overall = results.some((x) => x.status === STATUS.FAIL) ? STATUS.FAIL
      : results.some((x) => x.status === STATUS.WARNING) ? STATUS.WARNING
        : STATUS.PASS;

    if (projects && project) {
      await toolkit.saveContext(projects, project, {
        taskType,
        currentStage: 'shadow_validation',
        architecture: fp.data || null,
        validation: { status: overall, results: results.slice(0, 30).map((x) => ({ tool: x.tool, status: x.status, error: x.error || null })) },
        toolCalls: results.map((x, i) => ({ index: i, toolId: x.tool, status: x.status, cached: Boolean(x.cached), at: new Date().toISOString() })),
        filesInspected: [],
        nextAction: overall === STATUS.FAIL ? 'review_failures' : 'continue_workflow',
      }).catch(() => {});
    }

    return { ok: overall !== STATUS.FAIL, status: overall, plan, results, replans, stopped, toolCalls: calls, fingerprint: fp.data };
  }, { label: 'shadow orchestration' });
}
