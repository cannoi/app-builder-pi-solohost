/**
 * Honest job outcomes (Release A). Never map rollback / no-op / unverified to plain "done".
 * All user-facing text exists in English and Vietnamese; callers pass the user's language.
 */
export const OUTCOMES = Object.freeze({
  DONE: 'done',
  NO_CHANGE: 'no_change',
  ROLLED_BACK: 'rolled_back',
  PARTIAL: 'partial',
  NEEDS_ACTION: 'needs_action',
  FAILED: 'failed',
});

/** 'Vietnamese' (detectUserLanguage) | 'vi' | 'vi-VN' → 'vi'; everything else → 'en'. */
export function localeOf(language = '') {
  const l = String(language || '').toLowerCase();
  return l.startsWith('vi') ? 'vi' : 'en';
}

export function outcomeIcon(outcome) {
  switch (outcome) {
    case OUTCOMES.DONE: return '✓';
    case OUTCOMES.NO_CHANGE: return '○';
    case OUTCOMES.ROLLED_BACK: return '↩';
    case OUTCOMES.PARTIAL: return '◐';
    case OUTCOMES.NEEDS_ACTION: return '⚠';
    case OUTCOMES.FAILED: return '✗';
    default: return '•';
  }
}

const TITLES = {
  en: { done: 'Done', no_change: 'No code change', rolled_back: 'Rolled back', partial: 'Partly done', needs_action: 'Needs your action', failed: 'Failed' },
  vi: { done: 'Hoàn tất', no_change: 'Không có thay đổi mã', rolled_back: 'Đã hoàn tác', partial: 'Hoàn tất một phần', needs_action: 'Cần bạn thao tác', failed: 'Thất bại' },
};

/**
 * @param {{ locale?: string, outcome: string, reason?: string, next?: string }} opts
 */
export function formatOutcomeMessage({ locale = 'en', outcome, reason = '', next = '' } = {}) {
  const loc = localeOf(locale);
  const vi = loc === 'vi';
  const title = TITLES[loc][outcome] || outcome;
  const lines = [`${outcomeIcon(outcome)} ${title}`];
  if (reason) lines.push(reason);
  if (next) lines.push(vi ? `Tiếp theo: ${next}` : `Next: ${next}`);
  return lines.join('\n');
}

export function mapPatchResult({ filesChanged = 0, rolledBack = false, schemaMismatch = false, verified = false, unverified = false } = {}) {
  if (rolledBack) {
    return {
      outcome: OUTCOMES.ROLLED_BACK,
      reasonEn: 'Changes were rolled back after checks failed.',
      reasonVi: 'Thay đổi đã được hoàn tác vì kiểm tra không đạt.',
      nextEn: 'Share the error text or try a smaller change.',
      nextVi: 'Gửi nội dung lỗi hoặc thử một thay đổi nhỏ hơn.',
    };
  }
  if (schemaMismatch) {
    return {
      outcome: OUTCOMES.NEEDS_ACTION,
      reasonEn: 'AI answer did not match the expected format.',
      reasonVi: 'Câu trả lời của AI không đúng định dạng mong đợi.',
      nextEn: 'Try again, or rephrase the request.',
      nextVi: 'Thử lại hoặc diễn đạt lại yêu cầu.',
    };
  }
  if (!filesChanged) {
    return {
      outcome: OUTCOMES.NO_CHANGE,
      reasonEn: 'AI did not propose any file changes for this request.',
      reasonVi: 'AI không đề xuất thay đổi tệp nào cho yêu cầu này.',
      nextEn: 'Add more detail about what should change, or ask which files were inspected.',
      nextVi: 'Mô tả rõ hơn phần cần đổi, hoặc hỏi AI đã xem những tệp nào.',
    };
  }
  const full = verified && !unverified;
  return {
    outcome: full ? OUTCOMES.DONE : OUTCOMES.PARTIAL,
    reasonEn: full ? 'Changes applied and checks passed.' : 'Changes applied; some checks could not be run here.',
    reasonVi: full ? 'Đã áp dụng và kiểm tra đạt.' : 'Đã áp dụng; một số kiểm tra không chạy được ở đây.',
    nextEn: full ? 'Tap ▶ Run to see it, then 🚀 Publish.' : 'Tap ▶ Run to confirm the behavior.',
    nextVi: full ? 'Bấm ▶ Run để xem, rồi 🚀 Publish.' : 'Bấm ▶ Run để xác nhận hoạt động.',
  };
}

/** One call: structured result → localized text + icon (what the chat/UI shows). */
export function outcomeBrief(mapped, language = 'English', extra = {}) {
  const loc = localeOf(language);
  const vi = loc === 'vi';
  const reason = (vi ? mapped.reasonVi : mapped.reasonEn) + (extra.detail ? `\n${extra.detail}` : '');
  const next = vi ? mapped.nextVi : mapped.nextEn;
  return {
    outcome: mapped.outcome,
    icon: outcomeIcon(mapped.outcome),
    title: TITLES[loc][mapped.outcome] || mapped.outcome,
    reason,
    next,
    message: formatOutcomeMessage({ locale: loc, outcome: mapped.outcome, reason, next }),
  };
}
