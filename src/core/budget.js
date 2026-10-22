/**
 * Time budgets and AbortSignal helpers — never wait unbounded.
 */
export const BUDGET_MS = {
  AI_SIMPLE: Number(process.env.AI_TIMEOUT_SIMPLE_MS) || 45_000,
  AI_CODING: Number(process.env.AI_TIMEOUT_CODING_MS) || 90_000,
  AI_REQUEST_TOTAL: Number(process.env.AI_REQUEST_TOTAL_MS) || 120_000,
  AI_FETCH: Number(process.env.AI_FETCH_TIMEOUT_MS) || 45_000,
  ORCH_TASK: Number(process.env.ORCH_TASK_MS) || 5 * 60_000,
  JOB: Number(process.env.JOB_DEADLINE_MS) || 15 * 60_000,
  JOB_PUBLISH: Number(process.env.JOB_PUBLISH_MS) || 20 * 60_000,
  NETWORK: Number(process.env.NETWORK_TIMEOUT_MS) || 30_000,
  WATCHDOG: Number(process.env.JOB_WATCHDOG_MS) || 60_000,
  MAX_AI_ATTEMPTS: Number(process.env.AI_MAX_ATTEMPTS) || 3,
  MAX_ORCH_AI_CALLS: Number(process.env.ORCH_MAX_AI_CALLS) || 24,
};

export function createDeadline({ ms = BUDGET_MS.AI_REQUEST_TOTAL, parent = null, label = 'deadline' } = {}) {
  const start = Date.now();
  const parentRemaining = parent?.remaining?.() ?? Infinity;
  const limit = Math.max(1, Math.min(ms, parentRemaining === Infinity ? ms : parentRemaining));
  const controller = new AbortController();
  let timer = setTimeout(() => {
    try {
      controller.abort(Object.assign(new Error(`${label} timed out after ${limit}ms`), { code: 'DEADLINE' }));
    } catch { /* */ }
  }, limit);
  timer.unref?.();

  if (parent?.signal) {
    const onParent = () => {
      clearTimeout(timer);
      try {
        controller.abort(parent.signal.reason || new Error('parent aborted'));
      } catch { /* */ }
    };
    if (parent.signal.aborted) onParent();
    else parent.signal.addEventListener('abort', onParent, { once: true });
  }

  return {
    label,
    signal: controller.signal,
    remaining() {
      return Math.max(0, limit - (Date.now() - start));
    },
    check() {
      if (controller.signal.aborted) {
        const err = controller.signal.reason || new Error(`${label} aborted`);
        if (!err.code) err.code = 'DEADLINE';
        throw err;
      }
      return this.remaining();
    },
    abort(reason) {
      clearTimeout(timer);
      try {
        controller.abort(reason || new Error(`${label} aborted`));
      } catch { /* */ }
    },
  };
}

export function mergeSignals(...signals) {
  const list = signals.filter(Boolean);
  if (!list.length) return undefined;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list);
  const c = new AbortController();
  for (const s of list) {
    if (s.aborted) {
      c.abort(s.reason);
      break;
    }
    s.addEventListener('abort', () => c.abort(s.reason), { once: true });
  }
  return c.signal;
}

export function fetchWithBudget(url, opts = {}, budgetMs = BUDGET_MS.NETWORK) {
  const deadline = createDeadline({ ms: budgetMs, label: 'fetch' });
  const signal = mergeSignals(opts.signal, deadline.signal);
  return fetch(url, { ...opts, signal });
}
