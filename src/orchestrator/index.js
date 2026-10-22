/**
 * Orchestrator V3 entry: Plan → Execute → Verify → Repair → Replan
 */
import { isOrchestratorV3Enabled } from './flags.js';
import { classifyComplexity } from './router.js';
import { planWithAi, fallbackPlan, validatePlan } from './planner.js';
import { executeTask, makeProjectTools } from './executor.js';
import { verifyTask } from './verifier.js';
import { replanAfterFailure } from './replanner.js';
import { emptyState, saveOrchestratorState, loadOrchestratorState } from './state.js';
import { BUDGET_MS } from '../core/budget.js';
import { buildChecklist, evaluateChecklist } from '../engine/checklist.js';

export {
  isOrchestratorV3Enabled,
  classifyComplexity,
  planWithAi,
  fallbackPlan,
  validatePlan,
  executeTask,
  makeProjectTools,
  verifyTask,
  replanAfterFailure,
  emptyState,
  saveOrchestratorState,
  loadOrchestratorState,
};

function taskIcon(status) {
  if (status === 'done') return '✅';
  if (status === 'failed') return '⚠️';
  if (status === 'running') return '⏳';
  if (status === 'skipped' || status === 'blocked') return '⏭️';
  return '☐';
}

export function formatPlanCard(plan, taskState = {}, lang = 'en') {
  const lines = (plan?.tasks || []).map((t) => {
    const st = taskState[t.id]?.status || 'pending';
    return `${taskIcon(st)} ${t.id} ${t.title || t.goal || ''}`.slice(0, 120);
  });
  const head = lang.startsWith('vi') ? 'Kế hoạch' : 'Plan';
  return `${head}:\n${lines.join('\n')}`;
}

/**
 * Resume or run orchestrator for a complex MODIFY request.
 */
export async function runOrchestrator({
  ai,
  projectDir,
  request,
  lang = 'en',
  applyEdits,
  emit = () => {},
  scanBefore = null,
  scanProject = null,
  provider = '',
  model = '',
  resume = false,
} = {}) {
  if (!isOrchestratorV3Enabled()) {
    return { used: false, reason: 'flag off' };
  }
  const complexity = classifyComplexity({ request });
  if (complexity.level !== 'complex') {
    return { used: false, reason: 'trivial', complexity };
  }

  let state = resume ? await loadOrchestratorState(projectDir) : null;
  let plan = state?.plan || null;

  if (!plan) {
    emit('orchestrator', 'running', lang.startsWith('vi') ? 'Đang lập kế hoạch…' : 'Planning…');
    let planResult = ai
      ? await planWithAi({ ai, request, repoMap: { root: projectDir }, lang })
      : { ok: true, plan: fallbackPlan(request) };
    if (!planResult.ok || !planResult.plan) planResult = { ok: true, plan: fallbackPlan(request) };
    plan = planResult.plan;
    state = emptyState({ goal: plan.goal, plan });
    state.provider = provider;
    state.model = model;
  } else {
    emit('orchestrator', 'running', lang.startsWith('vi') ? 'Tiếp tục kế hoạch đã lưu…' : 'Resuming saved plan…');
  }

  // Feasibility
  if (plan.feasibility && plan.feasibility.ok === false && (plan.feasibility.conflicts || []).length) {
    const c = plan.feasibility.conflicts[0];
    return {
      used: true,
      needsUser: true,
      complexity,
      plan,
      question: { what: c.what, options: c.options || [], recommended: c.recommended },
      planCard: formatPlanCard(plan, state.tasks, lang),
    };
  }

  emit('orchestrator', 'plan', formatPlanCard(plan, state.tasks, lang));

  const tools = makeProjectTools(projectDir, { applyEdits });
  const completed = [];
  const failed = [];
  let aiCalls = 0;
  const maxAi = BUDGET_MS.MAX_ORCH_AI_CALLS || 24;
  const checklist = buildChecklist(request);

  for (const task of plan.tasks || []) {
    const prev = state.tasks[task.id];
    if (prev?.status === 'done') {
      completed.push(task.id);
      continue;
    }
    if (task.blocked || prev?.status === 'blocked') {
      emit('orchestrator', 'skipped', `${task.id} blocked`);
      continue;
    }
    if ((task.depends_on || []).some((id) => failed.includes(id) || state.tasks[id]?.status === 'failed')) {
      state.tasks[task.id] = { status: 'blocked' };
      emit('orchestrator', 'skipped', `${task.id} blocked by dependency`);
      continue;
    }

    state.tasks[task.id] = { status: 'running' };
    emit('orchestrator', 'running', `${taskIcon('running')} ${task.id}: ${task.title || task.goal}`);
    emit('orchestrator', 'plan', formatPlanCard(plan, state.tasks, lang));

    if (aiCalls >= maxAi) {
      emit('orchestrator', 'failed', 'AI call budget reached — finishing partial');
      failed.push(task.id);
      break;
    }
    aiCalls += 1;
    const exec = await executeTask({ ai, projectDir, task, tools, emit, allowWrite: Boolean(applyEdits) });
    const changed = (exec.final?.edits || []).map((e) => e.path).filter(Boolean);
    if (applyEdits && exec.final?.edits?.length) {
      try {
        await applyEdits(exec.final.edits);
      } catch (err) {
        emit('orchestrator', 'failed', `${task.id} apply: ${err.message || err}`);
      }
    }

    let scanAfter = null;
    if (typeof scanProject === 'function') {
      try {
        scanAfter = await scanProject(projectDir);
      } catch { /* */ }
    }

    const ver = await verifyTask({
      projectDir,
      task,
      changedFiles: changed,
      scanBefore,
      scanAfter,
      writeSmoke: true,
    });

    if (ver.ok) {
      state.tasks[task.id] = { status: 'done', verification: ver, provider, model };
      completed.push(task.id);
      emit('orchestrator', 'done', `${taskIcon('done')} ${task.id}`);
    } else {
      state.tasks[task.id] = { status: 'failed', verification: ver };
      failed.push(task.id);
      emit('orchestrator', 'failed', `${taskIcon('failed')} ${task.id}`);
      const rp = replanAfterFailure({ plan, failedTaskId: task.id, reason: ver.replanHint || 'acceptance', replanCount: state.replanCount || 0 });
      if (rp.askUser) {
        await saveOrchestratorState(projectDir, state);
        return {
          used: true,
          needsUser: true,
          complexity,
          plan,
          state,
          completed,
          failed,
          question: rp.question,
          planCard: formatPlanCard(plan, state.tasks, lang),
        };
      }
      if (rp.plan) {
        plan = rp.plan;
        state.plan = plan;
        state.replanCount = rp.replanCount;
      }
    }
    state.provider = provider;
    state.model = model;
    state.updatedAt = new Date().toISOString();
    await saveOrchestratorState(projectDir, state);
    emit('orchestrator', 'plan', formatPlanCard(plan, state.tasks, lang));
  }

  const brief = lang.startsWith('vi')
    ? `RESULT: Orchestrator\nDONE: ${completed.join(', ') || '—'}\nMISSING: ${failed.join(', ') || '—'}\nNEXT: Chạy thử hoặc hoàn tác nếu cần.`
    : `RESULT: Orchestrator\nDONE: ${completed.join(', ') || '—'}\nMISSING: ${failed.join(', ') || '—'}\nNEXT: Run preview or undo if needed.`;

  return {
    used: true,
    complexity,
    plan,
    state,
    completed,
    failed,
    checklist,
    brief,
    planCard: formatPlanCard(plan, state.tasks, lang),
    files: completed.length ? ['orchestrator-state.json'] : [],
  };
}
