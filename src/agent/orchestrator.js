/**
 * Agent Orchestrator: builds and tracks a step-by-step bug-fix plan
 * so both the pipeline and UI checklist stay synchronized on real progress.
 */
import { localeOf } from '../jobs/outcomes.js';
import { languageInstructionFor } from '../ai/language.js';

function nowIso() {
  return new Date().toISOString();
}

function detectFocusArea(feedback = '') {
  const q = String(feedback || '');
  if (/\b(play|start|game|canvas|restart|score|key|click|tap|chơi|bắt đầu|khởi động|bấm|nhấn|không chạy)\b/iu.test(q)) {
    return 'interaction';
  }
  if (/\b(api|fetch|404|500|cors|endpoint|save|post|get|database|data|cart|order|checkout|lỗi api|không lưu)\b/iu.test(q)) {
    return 'api_data';
  }
  if (/\b(layout|css|style|mobile|scroll|overflow|ui|button|modal|giao diện|tràn|cuộn|khuất)\b/iu.test(q)) {
    return 'ui_layout';
  }
  if (/\b(security|token|secret|auth|xss|injection|bảo mật)\b/iu.test(q)) {
    return 'security';
  }
  return 'general';
}

function buildContextualSteps({ feedback = '', language = 'English', runtime = null, acceptancePlan = null } = {}) {
  const loc = localeOf(language);
  const vi = loc === 'vi';
  const focus = detectFocusArea(feedback);
  const shortGoal = String(feedback || '').replace(/\s+/g, ' ').trim().slice(0, 110);
  const runtimeHint = runtime?.error ? String(runtime.error).slice(0, 90) : '';
  const criteriaCount = Array.isArray(acceptancePlan?.criteria) ? acceptancePlan.criteria.length : 0;

  const inspectDetail = runtimeHint
    ? (vi ? `Lỗi hiện tại: ${runtimeHint}` : `Observed runtime error: ${runtimeHint}`)
    : (vi ? 'Đọc tệp nguồn, log chạy gần nhất và lịch sử sửa' : 'Read affected files, recent logs, and repair history');

  const patchTitle = focus === 'interaction'
    ? (vi ? 'Sửa sự kiện nút bấm / vòng lặp điều khiển & trạng thái' : 'Patch startup, button/key event bindings & state flow')
    : focus === 'api_data'
      ? (vi ? 'Sửa route API, đồng bộ trường dữ liệu UI ↔ backend' : 'Fix API route handlers & align UI/backend payload fields')
      : focus === 'ui_layout'
        ? (vi ? 'Sửa bố cục giao diện, responsive và cuộn trang' : 'Fix UI layout, responsive breakpoints & scroll behavior')
        : focus === 'security'
          ? (vi ? 'Áp dụng bản vá bảo mật tối thiểu an toàn' : 'Apply minimal safe security patch')
          : (vi ? 'Chẩn đoán nguyên nhân gốc & vá đúng tệp liên quan' : 'Diagnose root cause & apply minimal targeted patch');

  const criteriaDetail = criteriaCount
    ? (vi ? `${criteriaCount} tiêu chí kiểm tra tự động` : `${criteriaCount} automated acceptance checks`)
    : (vi ? 'Xác định điều kiện bấm/hiển thị/không lỗi để nghiệm thu' : 'Define concrete click, render, and zero-error pass conditions');

  const templates = [
    {
      key: 'reproduce_inspect',
      title: vi ? 'Kiểm tra mã nguồn & tái hiện lỗi thực tế' : 'Inspect source, logs & reproduce failure',
      detail: inspectDetail,
    },
    {
      key: 'acceptance_criteria',
      title: vi ? 'Thiết lập tiêu chí nghiệm thu cho lỗi này' : 'Define acceptance criteria for this fix',
      detail: criteriaDetail,
    },
    {
      key: 'deterministic_check',
      title: vi ? 'Kiểm tra sửa nhanh an toàn (không tốn lượt AI thừa)' : 'Run fast deterministic fixes first (save AI calls)',
      detail: vi ? 'Tự kiểm tra cổng PORT, cấu hình runtime và lỗi phổ biến' : 'Verify PORT, runtime contract & known deterministic patterns',
    },
    {
      key: 'apply_patch',
      title: patchTitle,
      detail: shortGoal ? (vi ? `Mục tiêu: ${shortGoal}` : `Target: ${shortGoal}`) : '',
    },
    {
      key: 'verify_checks',
      title: vi ? 'Chạy kiểm tra tĩnh, test tự động & quét bảo mật' : 'Run static checks, automated tests & security scan',
      detail: '',
    },
    {
      key: 'live_browser_qa',
      title: vi ? 'Chạy thử app thật, chụp ảnh, click & cuộn kiểm chứng' : 'Run live app, capture screenshot, click & scroll QA',
      detail: '',
    },
    {
      key: 'finalize_or_rollback',
      title: vi ? 'Xác nhận hoàn tất hoặc hoàn tác & đề xuất phương án tối ưu' : 'Finalize verified fix or rollback & suggest best options',
      detail: '',
    },
  ];

  return templates.map((item, idx) => ({
    id: `step-${idx + 1}`,
    order: idx + 1,
    key: item.key,
    title: item.title,
    detail: item.detail,
    status: 'pending',
    updatedAt: nowIso(),
  }));
}

function recount(plan) {
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  plan.totalCount = steps.length;
  plan.doneCount = steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  plan.failedCount = steps.filter((s) => s.status === 'failed').length;
  plan.runningStep = steps.find((s) => s.status === 'running')?.key || null;
  plan.updatedAt = nowIso();
  return plan;
}

export async function createBugFixPlan({
  jobId = null,
  project = null,
  feedback = '',
  language = 'English',
  acceptancePlan = null,
  runtime = null,
  ai = null,
  useAi = false,
} = {}) {
  const loc = localeOf(language);
  const vi = loc === 'vi';
  let steps = buildContextualSteps({ feedback, language, runtime, acceptancePlan });

  if (useAi && ai && typeof ai.completeJson === 'function') {
    try {
      const prompt = `${languageInstructionFor(language)}
Create a concise step-by-step bug-fix checklist (5 to 7 steps) for this issue.
Project: ${project?.name || project?.slug || 'app'}
Issue report: ${String(feedback || '').slice(0, 600)}
Runtime status: ${runtime?.status || 'unknown'}${runtime?.error ? ` | Error: ${String(runtime.error).slice(0, 300)}` : ''}

Return ONLY JSON:
{"steps":[{"key":"inspect|criteria|patch|test|live_qa|finalize","title":"short actionable step","detail":"1 short concrete note"}]}`;
      const res = await Promise.race([
        ai.completeJson({
          task: 'PRODUCT_PLANNING',
          system: 'You create crisp, actionable bug-fix checklists grounded in the user bug report.',
          prompt,
          projectId: project?.id || null,
          validateJson: (v) => Array.isArray(v?.steps) && v.steps.length >= 3,
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('orchestrator_plan_timeout')), 8000)),
      ]);
      const rawSteps = (res?.json?.steps || [])
        .filter((s) => s && s.title)
        .slice(0, 8);
      if (rawSteps.length >= 3) {
        steps = rawSteps.map((s, idx) => ({
          id: `step-${idx + 1}`,
          order: idx + 1,
          key: String(s.key || `step_${idx + 1}`).toLowerCase().replace(/[^a-z0-9_]/g, '_'),
          title: String(s.title).slice(0, 140),
          detail: String(s.detail || '').slice(0, 200),
          status: 'pending',
          updatedAt: nowIso(),
        }));
      }
    } catch {
      // Keep deterministic contextual steps when AI planning is unavailable or slow
    }
  }

  const plan = {
    id: `orch-${Date.now().toString(36)}`,
    kind: 'bug_fix',
    jobId: jobId || null,
    projectId: project?.id || null,
    title: vi ? 'Kế hoạch sửa lỗi từng bước (Agent Orchestrator)' : 'Step-by-step Bug-Fix Plan (Agent Orchestrator)',
    goal: String(feedback || '').replace(/\s+/g, ' ').trim().slice(0, 260),
    language,
    locale: loc,
    status: 'running',
    steps,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  return recount(plan);
}

function findStep(plan, keyOrId) {
  if (!plan || !Array.isArray(plan.steps)) return null;
  return plan.steps.find((s) => s.key === keyOrId || s.id === keyOrId) || null;
}

export function startOrchestratorStep(plan, keyOrId, detail = undefined) {
  if (!plan || !Array.isArray(plan.steps)) return plan;
  for (const s of plan.steps) {
    if (s.status === 'running' && s.key !== keyOrId && s.id !== keyOrId) {
      s.status = 'done';
      s.updatedAt = nowIso();
    }
  }
  const target = findStep(plan, keyOrId);
  if (target) {
    target.status = 'running';
    if (detail !== undefined && detail !== null) target.detail = String(detail).slice(0, 260);
    target.updatedAt = nowIso();
  }
  return recount(plan);
}

export function completeOrchestratorStep(plan, keyOrId, detail = undefined) {
  if (!plan || !Array.isArray(plan.steps)) return plan;
  const target = findStep(plan, keyOrId);
  if (target) {
    target.status = 'done';
    if (detail !== undefined && detail !== null) target.detail = String(detail).slice(0, 260);
    target.updatedAt = nowIso();
  }
  return recount(plan);
}

export function failOrchestratorStep(plan, keyOrId, detail = undefined) {
  if (!plan || !Array.isArray(plan.steps)) return plan;
  const target = findStep(plan, keyOrId);
  if (target) {
    target.status = 'failed';
    if (detail !== undefined && detail !== null) target.detail = String(detail).slice(0, 260);
    target.updatedAt = nowIso();
  }
  return recount(plan);
}

export function skipOrchestratorStep(plan, keyOrId, detail = undefined) {
  if (!plan || !Array.isArray(plan.steps)) return plan;
  const target = findStep(plan, keyOrId);
  if (target) {
    target.status = 'skipped';
    if (detail !== undefined && detail !== null) target.detail = String(detail).slice(0, 260);
    target.updatedAt = nowIso();
  }
  return recount(plan);
}

export function finalizeOrchestratorPlan(plan, { outcome = 'DONE', verified = false, summary = '' } = {}) {
  if (!plan || !Array.isArray(plan.steps)) return plan;
  const loc = plan.locale || localeOf(plan.language);
  const vi = loc === 'vi';
  const ok = verified || outcome === 'DONE' || outcome === 'APPLIED' || outcome === 'NO_CHANGE';
  const finalStep = findStep(plan, 'finalize_or_rollback') || plan.steps[plan.steps.length - 1];
  for (const s of plan.steps) {
    if (s.status === 'running' && s !== finalStep) {
      s.status = ok ? 'done' : 'failed';
      s.updatedAt = nowIso();
    } else if (s.status === 'pending' && s !== finalStep) {
      s.status = 'skipped';
      s.updatedAt = nowIso();
    }
  }
  if (finalStep) {
    finalStep.status = ok ? 'done' : 'failed';
    finalStep.detail = String(
      summary || (ok
        ? (vi ? 'Đã kiểm tra và xác nhận bản sửa an toàn.' : 'Fix verified and saved.')
        : (vi ? 'Đã hoàn tác an toàn và đề xuất phương án tối ưu tiếp theo.' : 'Safely rolled back and proposed optimal next steps.')),
    ).slice(0, 260);
    finalStep.updatedAt = nowIso();
  }
  plan.status = ok ? 'done' : 'failed';
  return recount(plan);
}

export function formatPlanChecklistText(plan) {
  if (!plan || !Array.isArray(plan.steps)) return '';
  const icon = (s) => (s === 'done' ? '✅' : s === 'failed' ? '⚠️' : s === 'running' ? '⏳' : s === 'skipped' ? '⏭️' : '☐');
  const lines = [`${plan.title || 'Plan'} (${plan.doneCount || 0}/${plan.steps.length})`];
  for (const s of plan.steps) {
    lines.push(`${icon(s.status)} ${s.order}. ${s.title}${s.detail ? ` — ${s.detail}` : ''}`);
  }
  return lines.join('\n');
}

export class AgentOrchestrator {
  constructor({ ai = null, projects = null } = {}) {
    this.ai = ai;
    this.projects = projects;
  }

  async generatePlan(opts = {}) {
    const plan = await createBugFixPlan({ ai: this.ai, ...opts });
    if (this.projects && opts.project) {
      await this.projects.saveMetadata(opts.project, 'orchestrator-plan.json', plan).catch(() => {});
    }
    return plan;
  }

  async start(project, plan, key, detail) {
    startOrchestratorStep(plan, key, detail);
    if (this.projects && project) await this.projects.saveMetadata(project, 'orchestrator-plan.json', plan).catch(() => {});
    return plan;
  }

  async complete(project, plan, key, detail) {
    completeOrchestratorStep(plan, key, detail);
    if (this.projects && project) await this.projects.saveMetadata(project, 'orchestrator-plan.json', plan).catch(() => {});
    return plan;
  }

  async fail(project, plan, key, detail) {
    failOrchestratorStep(plan, key, detail);
    if (this.projects && project) await this.projects.saveMetadata(project, 'orchestrator-plan.json', plan).catch(() => {});
    return plan;
  }

  async skip(project, plan, key, detail) {
    skipOrchestratorStep(plan, key, detail);
    if (this.projects && project) await this.projects.saveMetadata(project, 'orchestrator-plan.json', plan).catch(() => {});
    return plan;
  }

  async finalize(project, plan, opts) {
    finalizeOrchestratorPlan(plan, opts);
    if (this.projects && project) await this.projects.saveMetadata(project, 'orchestrator-plan.json', plan).catch(() => {});
    return plan;
  }
}

export default {
  AgentOrchestrator,
  createBugFixPlan,
  startOrchestratorStep,
  completeOrchestratorStep,
  failOrchestratorStep,
  skipOrchestratorStep,
  finalizeOrchestratorPlan,
  formatPlanChecklistText,
};
