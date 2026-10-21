/**
 * Acceptance checklist for MODIFY flows (deterministic preferred).
 * P6: domain-aware items for multiplayer/LAN/network, not only color/login/button.
 */
export function buildChecklist(request = '') {
  const text = String(request || '').trim();
  const items = [];
  const push = (id, t, required, check) => items.push({ id, text: t, required: !!required, check });

  if (/(màu|color|nền|background|dark\s*mode)/iu.test(text)) {
    push('ui-color', 'UI color/theme change is present in source', true, {
      type: 'file_contains',
      path: null,
      pattern: /(background|color|dark)/i,
    });
  }
  if (/(đăng\s*nhập|login|auth)/iu.test(text)) {
    push('auth-ui', 'Login/auth related code exists', true, {
      type: 'file_contains',
      pattern: /(login|password|auth)/i,
    });
  }
  if (/(nút|button)/iu.test(text)) {
    push('button', 'Button markup or handler exists', false, {
      type: 'file_contains',
      pattern: /button/i,
    });
  }
  if (/(multiplayer|websocket|socket\.io|sse|lobby|room|lan|chơi mạng|nhiều người|đồng bộ)/iu.test(text)) {
    push('mp-server', 'Server exposes room/lobby or realtime endpoint', true, {
      type: 'file_contains',
      pattern: /(room|lobby|\/api\/.*room|EventSource|WebSocket|SSE|broadcast)/i,
    });
    push('mp-client', 'Client joins room or syncs state', true, {
      type: 'file_contains',
      pattern: /(joinRoom|join\(|roomId|lobby|EventSource|WebSocket)/i,
    });
    push('mp-health', 'Existing /health still referenced or served', true, {
      type: 'file_contains',
      pattern: /\/health/,
    });
  }
  if (/(dependency|package\.json|npm install|ws\b|socket\.io)/iu.test(text)) {
    push('dep-json', 'package.json lists intended dependency or zero-dep alternative documented', false, {
      type: 'file_contains',
      path: 'package.json',
      pattern: /dependencies|devDependencies/,
    });
  }

  push('no-crash', 'Static/syntax checks still pass', true, { type: 'run_check', check: 'static' });
  push('security', 'No new critical security findings', true, { type: 'run_check', check: 'scan' });
  if (items.length < 3) {
    push('manual-preview', 'Open preview and confirm the change', false, { type: 'manual' });
  }
  return items.slice(0, 8);
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
        const re =
          item.check.pattern instanceof RegExp
            ? item.check.pattern
            : new RegExp(String(item.check.pattern || ''), 'i');
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
      } else if (t === 'manual') {
        status = 'unverified';
        detail = 'user confirms in preview';
      }
    } catch (err) {
      status = 'fail';
      detail = String(err?.message || err).slice(0, 120);
    }
    out.push({ ...item, status, detail });
  }
  return out;
}

export function checklistPassed(evaluated) {
  return (evaluated || []).filter((i) => i.required).every((i) => i.status === 'pass');
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

export default { buildChecklist, evaluateChecklist, checklistPassed, checklistNeedsRepair, formatChecklistReport };
