/**
 * Compact Quality Report formatter & truthfulness guard (v1.11.0, N2).
 *
 * Truthfulness rule: never claim "working" unless runtime.start, http.health,
 * and (when Chromium exists) browser.desktop all PASS.
 */
import { STATUS } from './validation/status.js';

export const STATUS_SYMBOL = Object.freeze({
  PASS: '✓ PASS',
  WARNING: '⚠ WARNING',
  FAIL: '✗ FAIL',
  NOT_AVAILABLE: '– NOT_AVAILABLE',
  NOT_TESTED: '? NOT_TESTED',
});

function stepStatus(report, id) {
  return (report?.steps || []).find((s) => s.id === id)?.status || STATUS.NOT_TESTED;
}

export function detectReportLocale(text = '') {
  const s = String(text || '');
  if (/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(s)
    || /\b(tạo|sửa|nâng cấp|ứng dụng|bán hàng|giúp|kiểm tra|cài đặt|tiếng việt)\b/i.test(s)) {
    return 'vi';
  }
  return 'en';
}

export function canClaimWorking(report, { hasChromium } = {}) {
  const start = stepStatus(report, 'runtime.start');
  const health = stepStatus(report, 'http.health');
  const desktop = stepStatus(report, 'browser.desktop');
  const chromiumAvailable = hasChromium !== undefined
    ? Boolean(hasChromium)
    : desktop !== STATUS.NOT_AVAILABLE;

  if (start !== STATUS.PASS || health !== STATUS.PASS) return false;
  if (chromiumAvailable && desktop !== STATUS.PASS) return false;
  if ((report?.steps || []).some((s) => s.id !== 'report' && s.status === STATUS.FAIL)) return false;
  return true;
}

export function formatQualityReport({
  report = null,
  repairLoop = null,
  dareFixes = [],
  aiFixes = [],
  rollback = null,
  acceptanceCriteria = null,
  locale = 'en',
  hasChromium,
} = {}) {
  const vi = String(locale || 'en').toLowerCase().startsWith('vi');
  const steps = (report?.steps || []).filter((s) => s.id !== 'report');
  const desktopStatus = stepStatus(report, 'browser.desktop');
  const chromiumAvailable = hasChromium !== undefined
    ? Boolean(hasChromium)
    : desktopStatus !== STATUS.NOT_AVAILABLE;

  const working = canClaimWorking(report, { hasChromium: chromiumAvailable });
  const failingSteps = steps.filter((s) => s.status === STATUS.FAIL);
  const warningSteps = steps.filter((s) => s.status === STATUS.WARNING);

  let headline;
  if (working && !warningSteps.length) {
    headline = vi ? '✓ Hoạt động tốt (đã xác minh khi chạy)' : '✓ Working (runtime verified)';
  } else if (working) {
    headline = vi
      ? `⚠ Hoạt động tốt (có ${warningSteps.length} cảnh báo)`
      : `⚠ Working (${warningSteps.length} warning(s))`;
  } else {
    const exactFail = failingSteps.length
      ? failingSteps.slice(0, 3).map((s) => `${s.id}${s.message ? `: ${String(s.message).split('\n')[0].slice(0, 60)}` : ''}`).join(', ')
      : warningSteps.length
        ? warningSteps.slice(0, 2).map((s) => s.id).join(', ')
        : (!chromiumAvailable && stepStatus(report, 'http.health') !== STATUS.PASS)
          ? 'http.health'
          : (desktopStatus !== STATUS.PASS ? `browser.desktop (${desktopStatus})` : 'runtime verification');
    headline = vi
      ? `⚠ Hoàn thành một phần / Cần kiểm tra thêm — lỗi tại: ${exactFail}`
      : `⚠ Partially done / Needs attention — failing step: ${exactFail}`;
  }

  const keyIds = ['code.syntax_check', 'runtime.start', 'http.health', 'http.routes', 'browser.desktop', 'browser.mobile', 'browser.console'];
  const picked = [];
  const seen = new Set();
  for (const s of steps) {
    if (keyIds.includes(s.id) || s.status === STATUS.FAIL) {
      if (!seen.has(s.id)) {
        seen.add(s.id);
        picked.push(s);
      }
    }
  }
  const stepLines = picked.slice(0, 7).map((s) => {
    const sym = STATUS_SYMBOL[s.status] || s.status;
    const note = s.message && s.status !== STATUS.PASS ? ` (${String(s.message).split('\n')[0].slice(0, 55)})` : '';
    return `  ${sym} ${s.id}${note}`;
  });

  // Collect DARE auto-fixes & AI fixes from repairLoop history or explicit args
  const history = Array.isArray(repairLoop?.history) ? repairLoop.history : [];
  const autoFixed = [
    ...(Array.isArray(dareFixes) ? dareFixes : []),
    ...history.filter((h) => h.kind === 'dare' && h.applied !== false).map((h) => `${h.ruleId || 'DARE'}${Array.isArray(h.files) && h.files.length ? ` (${h.files.slice(0, 3).join(', ')})` : ''}`),
  ].filter(Boolean);

  const aiFixed = [
    ...(Array.isArray(aiFixes) ? aiFixes : []),
    ...history.filter((h) => h.kind === 'ai' && h.verdict !== 'rolled_back').map((h) => `${Array.isArray(h.files) && h.files.length ? h.files.slice(0, 3).join(', ') : 'patch'}${h.evidence ? ` — ${String(h.evidence).slice(0, 60)}` : ''}`),
  ].filter(Boolean);

  const rolledBackEntry = rollback
    || history.find((h) => h.verdict === 'rolled_back')
    || (repairLoop?.stopReason === 'rolled_back' ? { reason: repairLoop.reason || 'regression detected' } : null);

  const criteriaList = Array.isArray(acceptanceCriteria?.criteria)
    ? acceptanceCriteria.criteria
    : Array.isArray(acceptanceCriteria)
      ? acceptanceCriteria
      : Array.isArray(report?.acceptanceCriteria?.criteria)
        ? report.acceptanceCriteria.criteria
        : [];
  const notTestedCriteria = criteriaList.filter((c) => c.status !== STATUS.PASS && c.status !== STATUS.FAIL);

  const lines = [
    vi ? `Báo cáo chất lượng: ${headline}` : `Quality report: ${headline}`,
    ...stepLines,
  ];
  if (autoFixed.length) {
    lines.push((vi ? '  Tự động sửa (DARE): ' : '  Auto-fixed (DARE): ') + [...new Set(autoFixed)].slice(0, 3).join('; '));
  }
  if (aiFixed.length) {
    lines.push((vi ? '  AI đã sửa (có bằng chứng): ' : '  AI fixed with evidence: ') + [...new Set(aiFixed)].slice(0, 3).join('; '));
  }
  if (rolledBackEntry) {
    const why = typeof rolledBackEntry === 'string' ? rolledBackEntry : (rolledBackEntry.reason || rolledBackEntry.message || (vi ? 'kết quả kiểm tra kém đi' : 'validation regressed'));
    lines.push((vi ? '  Hoàn tác (Rollback): ' : '  Rollback: ') + String(why).slice(0, 100));
  }
  if (criteriaList.length) {
    const passCount = criteriaList.filter((c) => c.status === STATUS.PASS).length;
    const failCount = criteriaList.filter((c) => c.status === STATUS.FAIL).length;
    const ntText = notTestedCriteria.length
      ? `; ${vi ? 'chưa kiểm tra' : 'NOT_TESTED'}: ${notTestedCriteria.slice(0, 2).map((c) => c.text.slice(0, 36)).join(', ')}`
      : '';
    lines.push(vi
      ? `  Tiêu chí nghiệm thu: ${passCount}/${criteriaList.length} đạt${failCount ? `, ${failCount} lỗi` : ''}${ntText}`
      : `  Acceptance criteria: ${passCount}/${criteriaList.length} PASS${failCount ? `, ${failCount} FAIL` : ''}${ntText}`);
  }
  return lines.slice(0, 13).join('\n');
}

export default {
  STATUS_SYMBOL,
  canClaimWorking,
  detectReportLocale,
  formatQualityReport,
};
