/**
 * Deterministic Acceptance Criteria Evaluator (v1.11.0, N5).
 *
 * Maps plan.acceptance_checks to verifiable checks in a validation report.
 * Unmapped or unrun checks ALWAYS stay NOT_TESTED — never guessed PASS.
 */
import { STATUS } from './status.js';

function stepOf(report, id) {
  return (report?.steps || []).find((s) => s.id === id) || null;
}

function classifyCriterion(text) {
  const s = String(text || '').toLowerCase();
  if (/\/health|\bhealth\b|\bhealthcheck\b|\bhealth endpoint\b|sức khỏe/.test(s)) return 'health';
  if (/\bmobile\b|\b390\b|\bresponsive\b|\boverflow\b|di động/.test(s)) return 'mobile_friendly';
  if (/\bempty\b|\bno data\b|\bno items\b|trạng thái trống|chưa có dữ liệu/.test(s)) return 'empty_state';
  if (/\bprimary action\b|\bmain action\b|\bmain workflow\b|\bform\b|\bbutton\b|thao tác chính|người dùng có thể/.test(s)) return 'primary_action';
  if (/\bhome screen\b|\bmore than\b|\brenders\b|\bloads\b/.test(s)) return 'home_content';
  return 'unmapped';
}

function evalCriterion(item, report) {
  const text = typeof item === 'string' ? item : String(item?.text || item?.title || '');
  const key = classifyCriterion(text);
  const health = stepOf(report, 'http.health');
  const desktop = stepOf(report, 'browser.desktop');
  const mobile = stepOf(report, 'browser.mobile');
  const routes = stepOf(report, 'http.routes');

  if (key === 'health') {
    if (!health || health.status === STATUS.NOT_TESTED || health.status === STATUS.NOT_AVAILABLE) {
      return { text, key, status: STATUS.NOT_TESTED, evidence: health?.message || 'http.health not run' };
    }
    return {
      text,
      key,
      status: health.status === STATUS.PASS ? STATUS.PASS : STATUS.FAIL,
      evidence: health.message || health.status,
    };
  }

  if (key === 'mobile_friendly') {
    if (!mobile || mobile.status === STATUS.NOT_TESTED || mobile.status === STATUS.NOT_AVAILABLE) {
      return { text, key, status: STATUS.NOT_TESTED, evidence: mobile?.message || 'browser.mobile not run' };
    }
    const overflow = mobile.evidence?.checks?.overflowX;
    if (overflow === true) return { text, key, status: STATUS.FAIL, evidence: `horizontal overflow at 390px (${mobile.evidence?.checks?.scrollWidth}px)` };
    if (overflow === false) return { text, key, status: STATUS.PASS, evidence: 'no horizontal overflow at 390px' };
    return { text, key, status: mobile.status === STATUS.FAIL ? STATUS.FAIL : STATUS.PASS, evidence: mobile.message || mobile.status };
  }

  if (key === 'empty_state') {
    if (!desktop || desktop.status === STATUS.NOT_TESTED || desktop.status === STATUS.NOT_AVAILABLE) {
      return { text, key, status: STATUS.NOT_TESTED, evidence: desktop?.message || 'browser.desktop not run' };
    }
    const ev = desktop.evidence?.checks?.emptyStateVisible;
    if (ev === true) return { text, key, status: STATUS.PASS, evidence: 'empty-state indicator visible in DOM' };
    if (ev === false) return { text, key, status: STATUS.NOT_TESTED, evidence: 'no empty-state element detected on initial DOM (data may already be pre-populated)' };
    return { text, key, status: STATUS.NOT_TESTED, evidence: 'empty-state DOM check unavailable' };
  }

  if (key === 'primary_action') {
    if (desktop && ![STATUS.NOT_TESTED, STATUS.NOT_AVAILABLE].includes(desktop.status)) {
      const clicks = desktop.evidence?.interactions?.clicks || [];
      const forms = desktop.evidence?.interactions?.forms || [];
      const changed = clicks.some((c) => c.changed) || forms.some((f) => f.changed || (f.apiOk || 0) > 0);
      const apiErr = forms.some((f) => f.apiCalls > 0 && !f.apiOk);
      if (apiErr || desktop.status === STATUS.FAIL) {
        return { text, key, status: STATUS.FAIL, evidence: desktop.message || 'primary interaction failed' };
      }
      if (changed) {
        return { text, key, status: STATUS.PASS, evidence: `interaction changed DOM or returned 2xx API (${clicks.filter((c) => c.changed).length} click, ${forms.filter((f) => f.changed || f.apiOk).length} form)` };
      }
      if (clicks.length || forms.length) {
        return { text, key, status: STATUS.FAIL, evidence: 'interactive controls clicked/submitted with no DOM change or 2xx API response' };
      }
    }
    if (routes && routes.status === STATUS.PASS && (routes.evidence?.results || []).some((r) => String(r.path || '').startsWith('/api/') && r.verdict === STATUS.PASS)) {
      return { text, key, status: STATUS.PASS, evidence: 'API route responded 2xx (browser DOM interactions not run)' };
    }
    return { text, key, status: STATUS.NOT_TESTED, evidence: desktop?.message || 'browser interaction not run' };
  }

  if (key === 'home_content') {
    if (!desktop || desktop.status === STATUS.NOT_TESTED || desktop.status === STATUS.NOT_AVAILABLE) {
      return { text, key, status: STATUS.NOT_TESTED, evidence: desktop?.message || 'browser.desktop not run' };
    }
    const len = desktop.evidence?.checks?.bodyTextLength ?? 0;
    return {
      text,
      key,
      status: len >= 20 ? STATUS.PASS : STATUS.FAIL,
      evidence: `body text length ${len} chars`,
    };
  }

  return { text, key: 'unmapped', status: STATUS.NOT_TESTED, evidence: 'not mapped to automated check' };
}

export function evaluateAcceptanceCriteria(acceptanceChecks = [], report = {}) {
  const list = Array.isArray(acceptanceChecks) ? acceptanceChecks : [];
  const criteria = list.filter(Boolean).map((item) => evalCriterion(item, report));
  const summary = {
    total: criteria.length,
    pass: criteria.filter((c) => c.status === STATUS.PASS).length,
    fail: criteria.filter((c) => c.status === STATUS.FAIL).length,
    notTested: criteria.filter((c) => c.status !== STATUS.PASS && c.status !== STATUS.FAIL).length,
  };
  return { criteria, summary };
}

export default { evaluateAcceptanceCriteria };
