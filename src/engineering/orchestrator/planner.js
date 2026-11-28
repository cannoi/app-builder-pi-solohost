/**
 * Deterministic capability planner (v1.10.0, M5).
 * Every step carries an `expect` (allowed statuses) and an `onMismatch` policy:
 *   continue — record and go on · replan — call replan() for the rest · stop — end the plan
 * Budgets cap iterations and tool calls per task type.
 */
export const BUDGETS = Object.freeze({
  improve: { maxIterations: 8, maxToolCalls: 24 },
  repair: { maxIterations: 8, maxToolCalls: 24 },
  create: { maxIterations: 12, maxToolCalls: 40 },
  upgrade: { maxIterations: 12, maxToolCalls: 40 },
  import: { maxIterations: 8, maxToolCalls: 24 },
});

const OK = ['PASS', 'WARNING', 'NOT_AVAILABLE', 'NOT_TESTED'];

export function budgetFor(taskType) {
  const t = String(taskType || 'improve').toLowerCase();
  if (t.startsWith('create')) return BUDGETS.create;
  if (t.startsWith('upgrade')) return BUDGETS.upgrade;
  return BUDGETS[t] || BUDGETS.improve;
}

export function planForTask(taskType, fingerprint = {}, availableToolIds = []) {
  const has = (id) => availableToolIds.includes(id);
  const steps = [];
  const add = (tool, { expect = OK, onMismatch = 'continue', args = {} } = {}) => {
    if (!has(tool) && !tool.startsWith('code.') && !tool.startsWith('intel.') && tool !== 'validation.pipeline') return;
    steps.push({ tool, args, expect, onMismatch });
  };

  const type = String(taskType || 'improve').toLowerCase();
  add('intel.fingerprint', { onMismatch: 'stop' });
  add('intel.deps');
  add('intel.routes', { onMismatch: 'replan' });
  add('intel.env');
  if (type === 'improve' || type === 'repair') add('fs.list');
  if (type.startsWith('upgrade') && has('intel.config')) add('intel.config');
  add('code.syntax_check', { onMismatch: 'replan' });
  if (has('code.imports')) add('code.imports', { onMismatch: 'replan' });
  add('validation.pipeline', { expect: ['PASS', 'WARNING'], onMismatch: 'continue' });

  return {
    taskType: type,
    framework: fingerprint?.framework || 'unknown',
    budget: budgetFor(type),
    steps,
    createdAt: new Date().toISOString(),
  };
}

export function matchesExpectation(step, result) {
  const allowed = Array.isArray(step?.expect) ? step.expect : [step?.expect || 'PASS'];
  return allowed.includes(result?.status);
}

/**
 * Re-plan the remaining steps after a mismatch (deterministic):
 *  - syntax / import failure → runtime-dependent steps are pointless; keep only static validation
 *  - routes mismatch          → keep going but make sure validation runs (to record UNMATCHED calls)
 */
export function replan(remaining = [], step, result) {
  const reason = `${step.tool}=${result?.status}`;
  if (step.tool === 'code.syntax_check' || step.tool === 'code.imports') {
    return { reason, steps: remaining.filter((s) => s.tool !== 'validation.pipeline').concat([{ tool: 'validation.pipeline', args: { staticOnly: true }, expect: ['PASS', 'WARNING'], onMismatch: 'continue' }]) };
  }
  return { reason, steps: remaining };
}
