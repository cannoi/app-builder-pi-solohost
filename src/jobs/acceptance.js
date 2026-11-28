import { localeOf } from './outcomes.js';
import { languageInstructionFor } from '../ai/language.js';

const START_BUTTON_WORDS = [
  'play now', 'start game', 'new game', 'play', 'start', 'begin', 'restart', 'try again', 'continue',
  'chơi ngay', 'bắt đầu', 'chơi', 'khởi động', 'chơi lại', 'thử lại', 'tiếp tục',
];

const SUBMIT_BUTTON_WORDS = [
  'save', 'submit', 'add', 'create', 'send', 'search', 'apply', 'login', 'sign in',
  'lưu', 'gửi', 'thêm', 'tạo', 'tìm', 'áp dụng', 'đăng nhập',
];

export function extractTargetLabels(feedback = '') {
  const text = String(feedback || '');
  const quoted = [...text.matchAll(/["'“”‘’`]([^"'“”‘’`]{2,40})["'“”‘’`]/g)]
    .map((m) => m[1].trim())
    .filter(Boolean);
  return [...new Set(quoted)].slice(0, 5);
}

export function buildAcceptancePlan({ feedback = '', project = {}, language = 'English' } = {}) {
  const raw = String(feedback || '').trim();
  const combined = `${raw}\n${project?.idea || ''}`.trim();
  const loc = localeOf(language);
  const vi = loc === 'vi';

  const isGameOrStart = /\b(play|start|game|canvas|restart|retry|score|level|jump|move|shoot|snake|tetris|flappy|puzzle|arcade|chơi|bắt đầu|khởi động|nút|bấm|nhấn|click|tap|chạy được|không chạy|trò chơi)\b/iu.test(combined);
  const isScrollOrLayout = /\b(scroll|overflow|layout|responsive|mobile|cut|clip|overlap|screen|menu|list|cuộn|tràn|che|khuất|hiển thị|giao diện|màn hình)\b/iu.test(combined);
  const isFormOrInput = /\b(form|input|save|submit|add|create|search|login|register|filter|edit|delete|nhập|lưu|gửi|thêm|tạo|tìm|đăng nhập|sửa|xóa)\b/iu.test(raw);
  const isBugFix = /\b(fix|bug|broken|error|fail|crash|stuck|freeze|dead|not working|doesn't work|can't|cannot|unable|sửa|lỗi|hỏng|không thể|chưa chạy|không bấm|đơ|treo|không hoạt động)\b/iu.test(raw);

  const customTargets = extractTargetLabels(raw);
  const criteria = [
    {
      id: 'boot_ui',
      type: 'boot',
      required: true,
      labelEn: 'App starts, serves HTTP 200, and renders visible UI content',
      labelVi: 'Ứng dụng khởi động, phản hồi HTTP 200 và hiển thị giao diện rõ ràng',
    },
    {
      id: 'no_runtime_errors',
      type: 'no_errors',
      required: true,
      labelEn: 'Zero uncaught JavaScript errors, console errors, or failed app requests',
      labelVi: 'Không có lỗi JavaScript, lỗi console hoặc lỗi tải tài nguyên/API',
    },
  ];

  const verificationActions = [];

  if (isGameOrStart) {
    criteria.push({
      id: 'interactive_start',
      type: 'interaction',
      required: true,
      labelEn: 'Clicking Play/Start and pressing control keys starts or updates the app/game state',
      labelVi: 'Bấm nút Play/Bắt đầu và nhấn phím điều khiển làm thay đổi trạng thái app/game',
    });
    verificationActions.push({
      kind: 'click',
      targets: [...customTargets, ...START_BUTTON_WORDS],
      fallbackPrimaryButton: true,
      expectChange: true,
      waitMs: 450,
    });
    verificationActions.push({
      kind: 'canvas_and_keys',
      keys: ['Space', 'Enter', 'ArrowRight', 'ArrowDown'],
      expectChange: true,
      waitMs: 400,
    });
  } else if (isFormOrInput) {
    criteria.push({
      id: 'form_interaction',
      type: 'interaction',
      required: true,
      labelEn: 'Entering sample input and clicking the action button updates the UI without errors',
      labelVi: 'Nhập dữ liệu mẫu và bấm nút thực hiện làm cập nhật giao diện, không phát sinh lỗi',
    });
    verificationActions.push({
      kind: 'fill_and_submit',
      sampleText: 'Test item 123',
      targets: [...customTargets, ...SUBMIT_BUTTON_WORDS],
      expectChange: true,
      waitMs: 400,
    });
  } else {
    criteria.push({
      id: 'interactive_smoke',
      type: 'interaction',
      required: isBugFix,
      labelEn: 'Primary buttons/controls respond to clicks without runtime errors',
      labelVi: 'Các nút/điều khiển chính phản hồi khi bấm và không phát sinh lỗi chạy',
    });
    verificationActions.push({
      kind: 'click',
      targets: [...customTargets, ...START_BUTTON_WORDS, ...SUBMIT_BUTTON_WORDS],
      fallbackPrimaryButton: true,
      expectChange: isBugFix,
      waitMs: 400,
    });
  }

  criteria.push({
    id: 'scroll_layout',
    type: 'scroll',
    required: isScrollOrLayout,
    labelEn: 'Page scrolls cleanly without horizontal layout overflow or stuck overlays',
    labelVi: 'Trang cuộn mượt, không tràn ngang bất thường và không bị kẹt lớp phủ',
  });
  verificationActions.push({
    kind: 'scroll',
    deltaY: 420,
    waitMs: 250,
  });

  return {
    id: `acc-${Date.now().toString(36)}`,
    goal: raw.slice(0, 300),
    language,
    locale: loc,
    strictInteraction: isGameOrStart || isFormOrInput || isBugFix,
    criteria: criteria.map((c) => ({ ...c, label: vi ? c.labelVi : c.labelEn })),
    verificationActions,
    createdAt: new Date().toISOString(),
  };
}

export function formatAcceptancePlanSummary(plan, language = 'English') {
  const vi = localeOf(language) === 'vi';
  const header = vi ? '🎯 Mục tiêu & Tiêu chí nghiệm thu:' : '🎯 Goal & Acceptance Criteria:';
  const lines = (plan?.criteria || []).map((c, idx) => `${idx + 1}. ○ ${vi ? (c.labelVi || c.label) : (c.labelEn || c.label)}`);
  return [header, ...lines].join('\n');
}

export function evaluateAcceptance({ plan = {}, e2e = null, runtime = null, language = 'English' } = {}) {
  const loc = localeOf(language || plan.language);
  const vi = loc === 'vi';
  const criteria = Array.isArray(plan?.criteria) ? plan.criteria : [];
  const ev = e2e?.evidence || {};
  const browserSkipped = !e2e || e2e.status === 'skipped' || ev.browserAvailable === false;

  const pageErrors = Array.isArray(ev.pageErrors) ? ev.pageErrors : [];
  const consoleErrors = Array.isArray(ev.consoleErrors) ? ev.consoleErrors : [];
  const failedRequests = Array.isArray(ev.failedRequests) ? ev.failedRequests : [];
  const actionResults = Array.isArray(ev.actionResults) ? ev.actionResults : [];
  const initialMetrics = ev.initialMetrics || {};
  const afterMetrics = ev.afterMetrics || {};

  const evaluated = criteria.map((c) => {
    const label = vi ? (c.labelVi || c.label || c.id) : (c.labelEn || c.label || c.id);
    if (c.type === 'boot') {
      const hasUi = runtime?.health === true && (
        browserSkipped
          ? runtime?.status === 'passed'
          : (Number(initialMetrics.bodyTextLen || 0) > 0 || Number(initialMetrics.canvasCount || 0) > 0 || Number(initialMetrics.interactiveCount || 0) > 0)
      );
      if (hasUi && e2e?.status !== 'failed') {
        return { ...c, label, status: 'passed', detail: vi ? 'Trang tải thành công' : 'Page loaded cleanly' };
      }
      const err = e2e?.error || runtime?.error || (vi ? 'Giao diện trống hoặc server không phản hồi' : 'Blank UI or server failed health check');
      return { ...c, label, status: 'failed', detail: String(err).slice(0, 240) };
    }

    if (c.type === 'no_errors') {
      if (browserSkipped) {
        return { ...c, label, status: 'unverified', detail: vi ? 'Không có trình duyệt để bắt lỗi console' : 'Browser unavailable to capture console/JS errors' };
      }
      const totalErrs = pageErrors.length + consoleErrors.length + failedRequests.length;
      if (totalErrs === 0) {
        return { ...c, label, status: 'passed', detail: vi ? '0 lỗi JS/console/mạng' : '0 JS/console/network errors' };
      }
      const sample = [...pageErrors, ...consoleErrors, ...failedRequests.map((r) => `${r.status || 'ERR'} ${r.url}`)].slice(0, 3).join(' | ');
      return { ...c, label, status: 'failed', detail: sample.slice(0, 320) };
    }

    if (c.type === 'interaction') {
      if (browserSkipped) {
        return { ...c, label, status: 'unverified', detail: vi ? 'Chưa chạy được kiểm tra tương tác trình duyệt' : 'Browser interaction test could not run' };
      }
      const anyClickOrInput = actionResults.some((a) => a.performed);
      const changed = Boolean(ev.domChanged || ev.canvasChanged || ev.urlChanged || ev.inputAccepted);
      if (!anyClickOrInput && Number(initialMetrics.interactiveCount || 0) === 0) {
        return { ...c, label, status: 'failed', detail: vi ? 'Không tìm thấy nút hoặc vùng tương tác khả dụng' : 'No clickable buttons or interactive controls found' };
      }
      if (changed) {
        const ways = [ev.domChanged ? 'DOM' : '', ev.canvasChanged ? 'Canvas' : '', ev.inputAccepted ? 'Input' : ''].filter(Boolean).join('+');
        return { ...c, label, status: 'passed', detail: vi ? `Có phản hồi thật (${ways})` : `Verified state change (${ways})` };
      }
      // If user explicitly asked to fix a broken action / game start, zero change after clicking & pressing keys is a FAIL.
      if (c.required || plan.strictInteraction) {
        const tried = actionResults.filter((a) => a.performed).map((a) => a.summary || a.kind).join(', ') || 'click';
        return {
          ...c,
          label,
          status: 'failed',
          detail: vi
            ? `Đã thử (${tried}) nhưng màn hình và canvas không có bất kỳ thay đổi nào`
            : `Tried (${tried}) but neither DOM nor canvas changed state`,
        };
      }
      return { ...c, label, status: 'passed', detail: vi ? 'Thao tác không gây lỗi' : 'Interactions completed without error' };
    }

    if (c.type === 'scroll') {
      if (browserSkipped) {
        return { ...c, label, status: 'unverified', detail: vi ? 'Chưa kiểm tra cuộn trên trình duyệt' : 'Browser scroll check unavailable' };
      }
      const overflowPx = Number(afterMetrics.horizontalOverflow ?? initialMetrics.horizontalOverflow ?? 0);
      if (overflowPx > 40 && c.required) {
        return { ...c, label, status: 'failed', detail: vi ? `Tràn ngang ${overflowPx}px` : `Horizontal overflow detected (${overflowPx}px)` };
      }
      return { ...c, label, status: 'passed', detail: vi ? `Cuộn OK (overflow ${overflowPx}px)` : `Scroll OK (overflow ${overflowPx}px)` };
    }

    return { ...c, label, status: 'passed', detail: '' };
  });

  const failedRequired = evaluated.filter((c) => c.required && c.status === 'failed');
  const failedAny = evaluated.filter((c) => c.status === 'failed');
  const unverifiedRequired = evaluated.filter((c) => c.required && c.status === 'unverified');
  const passedCount = evaluated.filter((c) => c.status === 'passed').length;

  const passed = failedRequired.length === 0 && failedAny.length === 0 && runtime?.status === 'passed';
  const unverified = !passed && failedAny.length === 0 && unverifiedRequired.length > 0;

  const evidenceLines = [];
  if (failedAny.length) {
    evidenceLines.push(`FAILED ACCEPTANCE CRITERIA (${failedAny.length}):`);
    for (const c of failedAny) evidenceLines.push(`- [${c.id}] ${c.labelEn || c.label}: ${c.detail}`);
  }
  if (pageErrors.length) evidenceLines.push(`UNCAUGHT PAGE ERRORS:\n- ${pageErrors.slice(0, 5).join('\n- ')}`);
  if (consoleErrors.length) evidenceLines.push(`BROWSER CONSOLE ERRORS:\n- ${consoleErrors.slice(0, 5).join('\n- ')}`);
  if (failedRequests.length) evidenceLines.push(`FAILED NETWORK REQUESTS:\n- ${failedRequests.slice(0, 5).map((r) => `${r.status || 'ERR'} ${r.method || 'GET'} ${r.url} ${r.error || ''}`).join('\n- ')}`);
  if (actionResults.length) {
    evidenceLines.push(`INTERACTIONS TRIED IN REAL BROWSER:\n- ${actionResults.map((a) => `${a.kind}${a.target ? `(${a.target})` : ''}: performed=${a.performed}, changed=${a.changed}${a.note ? ` [${a.note}]` : ''}`).join('\n- ')}`);
  }
  if (initialMetrics.bodyTextSample || afterMetrics.bodyTextSample) {
    evidenceLines.push(`DOM SNAPSHOT: buttons=${afterMetrics.buttonCount ?? initialMetrics.buttonCount ?? 0}, canvas=${afterMetrics.canvasCount ?? initialMetrics.canvasCount ?? 0}, domChanged=${Boolean(ev.domChanged)}, canvasChanged=${Boolean(ev.canvasChanged)}, visibleText="${String(afterMetrics.bodyTextSample || initialMetrics.bodyTextSample || '').slice(0, 260)}"`);
  }

  const iconFor = (s) => (s === 'passed' ? '✓' : s === 'failed' ? '✗' : '○');
  const header = vi
    ? `📋 Nghiệm thu (${passedCount}/${evaluated.length} đạt):`
    : `📋 Acceptance check (${passedCount}/${evaluated.length} passed):`;
  const summaryText = [
    header,
    ...evaluated.map((c) => `${iconFor(c.status)} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`),
  ].join('\n');

  return {
    passed,
    unverified,
    passedCount,
    totalCount: evaluated.length,
    criteria: evaluated,
    failedCriteria: failedAny,
    summaryText,
    failureEvidence: evidenceLines.join('\n\n').slice(0, 3500),
  };
}

export async function buildOptimalAlternatives({
  feedback = '',
  evaluation = null,
  attempts = 0,
  lastFailure = '',
  language = 'English',
  ai = null,
  project = {},
} = {}) {
  const vi = localeOf(language) === 'vi';
  const failedSummary = (evaluation?.failedCriteria || []).map((c) => `${c.label}: ${c.detail}`).join('; ') || String(lastFailure || '').slice(0, 300);

  const deterministic = vi ? [
    {
      id: 'clean_module_rewrite',
      title: 'Viết lại sạch phần xử lý chính bị kẹt',
      description: 'Thay vì vá chắp lên mã cũ đang rối sự kiện/trạng thái, viết lại gọn riêng hàm khởi tạo, nút bấm và vòng lặp chính.',
      suggestedPrompt: `Hãy viết lại sạch logic khởi chạy và xử lý sự kiện chính để giải quyết dứt điểm: ${String(feedback).slice(0, 140)}`,
    },
    {
      id: 'switch_ai_or_step',
      title: 'Chia nhỏ lỗi và dùng model mạnh hơn',
      description: 'Mở ⚙ Settings chọn Gemini (hoặc model mạnh hơn có hỗ trợ xem ảnh chụp màn hình) rồi yêu cầu sửa đúng 1 nút/chức năng cụ thể.',
      suggestedPrompt: `Chỉ sửa đúng 1 lỗi này trước: ${failedSummary ? failedSummary.slice(0, 120) : String(feedback).slice(0, 120)}`,
    },
    {
      id: 'inspect_or_run_local',
      title: 'Chạy thử bản ổn định gần nhất hoặc tải ZIP kiểm tra',
      description: 'Mã nguồn đã được hoàn tác về điểm lưu an toàn. Bạn có thể mở ⋯ → ⬇ Tải ZIP hoặc chạy bằng script trên PC để kiểm tra môi trường thực tế.',
      suggestedPrompt: '',
    },
  ] : [
    {
      id: 'clean_module_rewrite',
      title: 'Cleanly rebuild only the stuck handler/module',
      description: 'Instead of patching around tangled event listeners or state, rewrite just the startup, button binding, and main loop cleanly.',
      suggestedPrompt: `Cleanly rewrite only the startup and main interaction handler to fix: ${String(feedback).slice(0, 140)}`,
    },
    {
      id: 'switch_ai_or_step',
      title: 'Split the task and try a stronger vision-capable model',
      description: 'Open ⚙ Settings and pick Gemini (supports inspecting live screenshots) or ask to fix one specific button or screen at a time.',
      suggestedPrompt: `Fix only this single verified failure first: ${failedSummary ? failedSummary.slice(0, 120) : String(feedback).slice(0, 120)}`,
    },
    {
      id: 'inspect_or_run_local',
      title: 'Keep safe checkpoint or download ZIP to test locally',
      description: 'Your app was safely restored to the last clean checkpoint. You can export via ⋯ → ⬇ Download ZIP or test with the PC run script.',
      suggestedPrompt: '',
    },
  ];

  // Try brief AI-tailored optimal alternatives when AI is available, with instant safe fallback.
  if (ai && typeof ai.completeJson === 'function') {
    try {
      const prompt = `${languageInstructionFor(language)}
The Builder tried ${attempts} verify-driven repair pass(es) for this user request, running the app in a headless browser, clicking/scrolling, and checking acceptance criteria — and it STILL did not pass.
User request: ${String(feedback).slice(0, 500)}
Project: ${project?.name || project?.slug || 'app'}
Failed criteria & browser evidence: ${failedSummary || String(lastFailure || '').slice(0, 800)}

Propose 2 to 3 OPTIMAL, PRACTICAL alternatives for a non-technical user so they can succeed next.
Return ONLY JSON:
{"summary":"1-2 short honest sentences in user language explaining why automatic patching stopped","alternatives":[{"title":"short option title","description":"1 concise plain-language sentence why this helps","suggestedPrompt":"optional one-click chat prompt user can send next, or empty string"}]}`;

      const res = await Promise.race([
        ai.completeJson({
          task: 'USER_CHAT',
          system: 'You advise users honestly when automated repair did not pass acceptance verification.',
          prompt,
          projectId: project?.id || null,
          validateJson: (v) => v && Array.isArray(v.alternatives) && v.alternatives.length >= 1,
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('alternatives_timeout')), 8000)),
      ]);
      const items = (res?.json?.alternatives || [])
        .filter((a) => a && (a.title || a.description))
        .slice(0, 3)
        .map((a, idx) => ({
          id: `alt-${idx + 1}`,
          title: String(a.title || '').slice(0, 100),
          description: String(a.description || '').slice(0, 260),
          suggestedPrompt: String(a.suggestedPrompt || '').slice(0, 240),
        }));
      if (items.length) {
        return {
          summary: String(res.json.summary || '').slice(0, 320),
          items,
        };
      }
    } catch { /* keep deterministic localized alternatives */ }
  }

  return {
    summary: vi
      ? `Builder đã chạy thử và kiểm tra tương tác qua ${attempts} lượt sửa nhưng chưa đạt đủ tiêu chí nghiệm thu.`
      : `Builder ran live browser and interaction checks across ${attempts} repair attempt(s), but acceptance criteria still failed.`,
    items: deterministic,
  };
}

export function formatAlternativesMessage(alternatives, language = 'English') {
  const vi = localeOf(language) === 'vi';
  const list = Array.isArray(alternatives?.items) ? alternatives.items : [];
  if (!list.length) return '';
  const header = vi ? '💡 Phương án tối ưu đề xuất:' : '💡 Recommended next options:';
  const lines = [header];
  if (alternatives.summary) lines.push(alternatives.summary);
  list.forEach((item, idx) => {
    lines.push(`${idx + 1}. ${item.title} — ${item.description}`);
  });
  return lines.join('\n');
}
