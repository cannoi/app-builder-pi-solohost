/**
 * First-run product quality: domain feature hints + anti UI-collapse rules.
 * Learned from real outputs like milk-tea-order-manager (bare HTML, broken POST body, missing cart).
 */

export function domainFeatureHints(idea = '') {
  const q = String(idea || '').toLowerCase();
  const hints = [];

  const isOrder = /\b(order|cart|menu|shop|store|milk\s*tea|coffee|pos|bán|đặt hàng|giỏ|thực đơn|trà sữa|quán)\b/i.test(q);
  const isCrm = /\b(crm|customer|pipeline|contact|khách hàng)\b/i.test(q);
  const isTask = /\b(task|todo|kanban|project|công việc)\b/i.test(q);

  if (isOrder) {
    hints.push(
      'ORDER/MENU APP: implement (1) menu list with name+price, (2) add/edit items with matching API body fields, (3) simple cart or order list with totals, (4) persist data under /data or memory with clear save.',
      'API coherence: if UI POSTs {name,price} the server must accept {name,price}; do not only support {id,price} update while the form sends create fields.',
      'Separate customer view (browse + add to cart) from admin/menu editor if space allows — still one page is OK with two clear sections.',
    );
  }
  if (isCrm) {
    hints.push('CRM: contacts list + form (name, email/stage) + POST/GET API that share the same field names.');
  }
  if (isTask) {
    hints.push('TASKS: task list + status field + add form; empty state message.');
  }
  if (!hints.length) {
    hints.push('Implement the primary user journey end-to-end: list + create form + API with matching JSON fields.');
  }
  return hints;
}

/** Prompt block injected into template customize / improve to prevent demo-level UI regression */
export function professionalUiGuard() {
  return `UI QUALITY GUARD (mandatory):
- Do NOT collapse the UI into a bare unstyled page (no single-line HTML, no "Loading..." only demo).
- Keep a professional layout: header/status, card sections, readable typography, spacing, form labels, primary button, list panel.
- Keep CSS in <style> (or a stylesheet) with layout for mobile and desktop (max-width container, grid/flex).
- Keep working fetch() calls, empty states, and basic error/toast feedback.
- Preserve /health, Dockerfile, docker-compose.yml (127.0.0.1, pi.ui.primary), config_options.yml.
- Prefer improving the existing professional template UI over rewriting a minimal shell from scratch.
- Every form field the UI sends must be handled by the matching API route (no silent no-ops).
- INTERNATIONAL UX (mandatory): provide English + Vietnamese UI copy using a real language switcher or a shared translation dictionary; persist the selected language; never mix languages in one view.
- Use meaningful, consistent icons (inline SVG or lightweight Unicode symbols) with accessible labels; do not depend on remote icon/CDN assets.
- Chat/AI surfaces must detect the user's message language and reply in that same language. Keep this behavior explicit in the system prompt and preserve it in UI/API wiring.
- First-run must be usable by a non-technical person: helpful empty states, inline validation, loading/disabled states, success/error feedback, and sample-free real workflows.
- Responsive quality is required: viewport meta, mobile breakpoint, keyboard focus, semantic labels, and accessible button names.
- Do not claim a feature works unless its UI, API, persistence path, and error handling are all implemented.`;
}

export function buildCustomizePrompt({ idea, templateId, phase, assessment }) {
  const hints = domainFeatureHints(idea);
  const issues = (assessment?.depth?.issues || assessment?.issues || []).join(', ') || 'none';
  return [
    professionalUiGuard(),
    `Template base: ${templateId || 'unknown'}`,
    `User request: ${idea}`,
    `Checklist issues: ${issues}; score=${assessment?.depth?.score ?? assessment?.score ?? 'n/a'}`,
    `Domain requirements:\n- ${hints.join('\n- ')}`,
    phase === 1
      ? 'PHASE 1: Map template form/list/API to this product domain with professional UI (not a demo).'
      : phase === 2
        ? 'PHASE 2: Complete primary journey (create+list+any cart/order/total). Fix API field mismatches.'
        : 'PHASE 3: Polish copy, empty states, validation; remove placeholders; first-run ready for a shop owner.',
  ].join('\n\n');
}

/** Extra product-checklist signals for professional first-run UI */
export function professionalUiMetrics(html = '', server = '') {
  const issues = [];
  const metrics = {
    cssChars: 0,
    hasHeader: false,
    hasLayout: false,
    minifiedBare: false,
    visibleChars: 0,
  };
  // Strip made-by badge styles so badge alone cannot fake a professional UI
  const htmlNoBadge = String(html)
    .replace(/<style[^>]*>[\s\S]*?\.paf-made-by[\s\S]*?<\/style>/gi, '')
    .replace(/<img[^>]*paf-made-by[^>]*>/gi, '');
  const cssMatch = htmlNoBadge.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  let css = cssMatch ? cssMatch[1] : '';
  css = css.replace(/\.paf-made-by[\s\S]*?(?=}|$)/g, '');
  metrics.cssChars = css.length;
  metrics.hasHeader = /<header[\s>]/i.test(htmlNoBadge) || /class=["'][^"']*brand/i.test(htmlNoBadge);
  metrics.hasLayout = /display\s*:\s*grid|display\s*:\s*flex|grid-template|flex-direction|\.card\b/i.test(css)
    || /class=["'][^"']*\b(card|grid|layout)\b/i.test(htmlNoBadge);
  const visible = htmlNoBadge
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  metrics.visibleChars = visible.length;
  metrics.hasViewport = /<meta[^>]+name=[\"']viewport[\"']/i.test(htmlNoBadge);
  metrics.hasResponsive = /@media\s*\(/i.test(css);
  metrics.hasFormLabels = /<label\b/i.test(htmlNoBadge) || /aria-label=/i.test(htmlNoBadge);
  metrics.hasIcons = /<svg\b|\bicon-[a-z0-9-]+|[\u{1F300}-\u{1FAFF}]/iu.test(htmlNoBadge);
  metrics.hasLanguageFoundation = /\blang=[\"'](?:en|vi)/i.test(htmlNoBadge)
    && /(language|locale|i18n|translations|data-i18n)/i.test(htmlNoBadge);
  const compact = htmlNoBadge.replace(/\s+/g, ' ').trim();
  metrics.minifiedBare =
    (compact.length > 0 && compact.length < 1100 && metrics.cssChars < 100)
    || (metrics.visibleChars < 90 && !metrics.hasHeader)
    || (metrics.cssChars < 60 && metrics.visibleChars < 140);
  if (metrics.minifiedBare) issues.push('ui_unprofessional_bare');
  if (metrics.cssChars < 120 && !metrics.hasLayout) issues.push('ui_lacks_layout_css');
  if (html && !metrics.hasViewport) issues.push('ui_missing_viewport');
  if (html && !metrics.hasResponsive) issues.push('ui_missing_mobile_layout');
  if (html && !metrics.hasFormLabels && /<form\b/i.test(htmlNoBadge)) issues.push('ui_missing_accessible_labels');
  // API field mismatch: UI clearly uses name+price create, server POST only destructures id/price
  if (/getElementById\(['"]name['"]\)|name=["']name["']/i.test(html) && /price/i.test(html)) {
    if (/req\.body/.test(server) || /const\s*\{[^}]*\}\s*=\s*req\.body/.test(server)) {
      const onlyIdPrice = /const\s*\{\s*id\s*,\s*price\s*\}/.test(server)
        || /const\s*\{\s*id\s*\}/.test(server);
      const acceptsName = /\bname\b/.test(server) && /req\.body|body\.name|\{[^}]*name/.test(server);
      if (onlyIdPrice && !acceptsName) issues.push('api_ui_field_mismatch');
    }
  }
  return { metrics, issues };
}

export default {
  domainFeatureHints,
  professionalUiGuard,
  buildCustomizePrompt,
  professionalUiMetrics,
};
