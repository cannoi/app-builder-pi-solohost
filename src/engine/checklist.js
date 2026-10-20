/**
 * Acceptance checklist for MODIFY flows (deterministic preferred).
 */
export function buildChecklist(request = '') {
  const text = String(request || '').trim();
  const items = [];
  const push = (id, t, required, check) => items.push({ id, text: t, required: !!required, check });

  if (/(màu|color|nền|background|dark\s*mode)/iu.test(text)) {
    push('ui-color', 'UI color/theme change is present in source', true, { type: 'file_contains', path: null, pattern: /(background|color|dark)/i });
  }
  if (/(đăng\s*nhập|login|auth)/iu.test(text)) {
    push('auth-ui', 'Login/auth related code exists', true, { type: 'file_contains', pattern: /(login|password|auth)/i });
  }
  if (/(nút|button)/iu.test(text)) {
    push('button', 'Button markup or handler exists', false, { type: 'file_contains', pattern: /button/i });
  }
  // Always include generic items
  push('no-crash', 'Static/syntax checks still pass', true, { type: 'run_check', check: 'static' });
  push('security', 'No new critical security findings', true, { type: 'run_check', check: 'scan' });
  if (items.length < 3) {
    push('manual-preview', 'Open preview and confirm the change', false, { type: 'manual' });
  }
  return items.slice(0, 5);
}

export async function evaluateChecklist(items, ctx = {}) {
  const out = [];
  for (const item of items || []) {
    let status = 'unverified';
    let detail = '';
    try {
      const t = item.check?.type;
      if (t === 'file_contains') {
        const files = ctx.fileContents || {};
        const re = item.check.pattern instanceof RegExp ? item.check.pattern : new RegExp(String(item.check.pattern || ''), 'i');
        const paths = item.check.path ? [item.check.path] : Object.keys(files);
        const hit = paths.some((p) => re.test(String(files[p] || '')));
        status = hit ? 'pass' : 'fail';
        detail = hit ? 'pattern found' : 'pattern not found';
      } else if (t === 'run_check') {
        const key = item.check.check || 'static';
        const result = ctx.checks?.[key];
        if (!result) status = 'unverified';
        else if (key === 'scan') {
          status = (result.critical || 0) === 0 ? 'pass' : 'fail';
          detail = `critical=${result.critical || 0}`;
        } else {
          status = result.status === 'passed' || result.status === 'pass' ? 'pass' : 'fail';
          detail = result.status || '';
        }
      } else if (t === 'http' && ctx.fetchUrl) {
        const res = await ctx.fetchUrl(item.check.url || ctx.previewUrl);
        status = res?.ok ? 'pass' : 'fail';
      } else if (t === 'dom' && ctx.queryDom) {
        const ok = await ctx.queryDom(item.check.selector);
        status = ok ? 'pass' : 'fail';
      } else {
        status = 'unverified';
      }
    } catch (err) {
      status = 'unverified';
      detail = String(err.message || err).slice(0, 120);
    }
    out.push({ ...item, status, detail });
  }
  return out;
}

export function checklistNeedsRepair(results) {
  return (results || []).some((r) => r.required && r.status === 'fail');
}

export function formatChecklistReport(results, language = 'en') {
  const lines = (results || []).map((r) => `- [${r.status}] ${r.text}${r.detail ? ` (${r.detail})` : ''}`);
  if (String(language).toLowerCase().startsWith('vi')) {
    return `Checklist:\n${lines.join('\n')}`;
  }
  return `Checklist:\n${lines.join('\n')}`;
}

export default { buildChecklist, evaluateChecklist, checklistNeedsRepair, formatChecklistReport };
