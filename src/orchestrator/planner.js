/**
 * AI planner with schema validation + one repair retry.
 */
import { SOLOHOST_CONTRACT } from '../ai/prompts.js';

export const PLAN_SCHEMA_HINT = `{
  "goal": "string",
  "feasibility": { "ok": true, "conflicts": [{"what":"","options":[],"recommended":""}], "assumptions": [] },
  "decisions": [{"topic":"","choice":"","why":""}],
  "tasks": [{
    "id": "T1",
    "title": "",
    "goal": "",
    "files_expected": [],
    "depends_on": [],
    "acceptance": [{"type":"http|grep|node-check|dom|script","spec":""}],
    "risk": "low|medium|high",
    "rollback": "task|none"
  }]
}`;

export function validatePlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== 'object') return { ok: false, errors: ['plan not object'] };
  if (!plan.goal) errors.push('missing goal');
  if (!plan.feasibility || typeof plan.feasibility.ok !== 'boolean') errors.push('feasibility.ok required');
  if (!Array.isArray(plan.tasks) || plan.tasks.length < 1) errors.push('tasks must be non-empty array');
  else {
    for (const t of plan.tasks) {
      if (!t.id || !t.goal) errors.push(`task ${t.id || '?'} missing id/goal`);
      if (!Array.isArray(t.acceptance) || !t.acceptance.length) errors.push(`task ${t.id} missing acceptance`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export async function planWithAi({
  ai,
  request,
  repoMap = {},
  previousFailures = [],
  lang = 'en',
} = {}) {
  const system = `You are the App Builder planner for SoloHost apps.
Return ONLY valid JSON matching the schema.
Respect SoloHost constraints: ${String(SOLOHOST_CONTRACT || '').slice(0, 1200)}
Prefer zero new native dependencies. Prefer SSE/POST over WebSocket if npm network may be offline.
Flag conflicts (e.g. LAN access vs 127.0.0.1 bind) in feasibility.conflicts with options — do not silently weaken the contract.
User language: ${lang}.`;

  const prompt = `USER REQUEST:\n${request}\n\nREPO MAP:\n${JSON.stringify(repoMap).slice(0, 12000)}\n\nPREVIOUS FAILURES:\n${JSON.stringify(previousFailures).slice(0, 3000)}\n\nSCHEMA:\n${PLAN_SCHEMA_HINT}`;

  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await ai.completeJson({
      task: 'ORCHESTRATOR_PLAN',
      system: attempt === 0 ? system : system + '\nPrevious JSON was invalid: ' + lastErr,
      prompt,
    });
    const plan = r?.json;
    const v = validatePlan(plan);
    if (v.ok) return { ok: true, plan };
    lastErr = v.errors.join('; ');
  }
  return { ok: false, error: lastErr || 'plan validation failed', plan: null };
}

/** Deterministic fallback plan when AI unavailable (for tests / offline). */
export function fallbackPlan(request) {
  return {
    goal: String(request || 'improve app').slice(0, 200),
    feasibility: { ok: true, conflicts: [], assumptions: ['fallback plan without AI'] },
    decisions: [],
    tasks: [
      {
        id: 'T1',
        title: 'Inspect and apply focused change',
        goal: String(request || '').slice(0, 300),
        files_expected: [],
        depends_on: [],
        acceptance: [{ type: 'node-check', spec: 'changed js files parse' }],
        risk: 'medium',
        rollback: 'task',
      },
    ],
  };
}
