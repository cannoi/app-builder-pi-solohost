import { matchTemplates, getTemplateById, readTemplateCatalog } from './library.js';

const DEMO_IDS = new Set(['hello-ai-app', 'sandbox-benchmark', 'demo', 'demo-app', 'sample-app']);

export function isDemoTemplate(t) {
  if (!t) return true;
  const id = String(t.id || '').toLowerCase();
  if (DEMO_IDS.has(id)) return true;
  if (t.demo === true) return true;
  if (String(t.kind) === 'reference') return true;
  if (t.internalOnly === true) return true;
  const tags = (t.tags || []).map((x) => String(x).toLowerCase());
  if (tags.includes('demo') || tags.includes('sandbox-only')) return true;
  return false;
}

export function isRealTemplate(t) {
  if (!t || !t.instantiable) return false;
  if (isDemoTemplate(t)) return false;
  if (t.thinOverlay || t.fetch) return true;
  if (t.standardSoloHost || String(t.id).startsWith('std-')) return true;
  if (t.completeSoloHostApp || t.piNetworkOptimized || t.qualityBaseline) return true;
  return t.kind === 'source' && t.instantiable;
}

export async function isNetworkAvailable({ timeoutMs = 3500 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch('https://api.github.com', {
      method: 'HEAD',
      signal: controller.signal,
      headers: { 'User-Agent': 'AppBuilder-SoloHost/1.8.41' },
    });
    return res.status > 0;
  } catch {
    try {
      const res = await fetch('https://codeload.github.com', {
        method: 'HEAD',
        signal: controller.signal,
        headers: { 'User-Agent': 'AppBuilder-SoloHost/1.8.41' },
      });
      return res.status > 0;
    } catch {
      return false;
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function selectRealTemplate(templatesDir, idea, {
  preferredId = null,
  limit = 12,
  requireNetworkForThin = true,
} = {}) {
  const network = await isNetworkAvailable();
  const match = await matchTemplates(templatesDir, idea, { limit });
  const catalog = await readTemplateCatalog(templatesDir);
  const byId = new Map(catalog.map((t) => [t.id, t]));
  const candidates = [];
  const pushId = (id, score, why) => {
    if (!id) return;
    const t = byId.get(id);
    if (!isRealTemplate(t)) return;
    if ((t.thinOverlay || t.fetch) && requireNetworkForThin && !network) return;
    candidates.push({ id, template: t, score, why });
  };

  if (preferredId) {
    const t = await getTemplateById(templatesDir, preferredId);
    if (isRealTemplate(t) && (!(t.thinOverlay || t.fetch) || network)) {
      return { templateId: t.id, template: t, match, network, reason: `user-selected real template «${t.id}»` };
    }
  }

  if (match.selected_template_id) pushId(match.selected_template_id, (match.match_score || 0) + 20, 'matcher-top');
  for (const alt of match.alternative_template_ids || []) pushId(alt, 40, 'matcher-alt');
  const cat = match.selected?.category;
  if (cat) pushId(`std-${cat}`, 55, 'std-category');
  if (network) {
    for (const t of catalog) {
      if (!(t.thinOverlay && t.instantiable && isRealTemplate(t))) continue;
      const hay = `${t.id} ${t.name} ${t.description} ${(t.tags || []).join(' ')}`.toLowerCase();
      const tokens = String(idea || '').toLowerCase().split(/[^a-z0-9àáạảãâăèéẹẻẽêìíịỉĩòóọỏõôơùúụủũưỳýỵỷỹđ]+/i).filter((w) => w.length > 2);
      let s = 12;
      for (const tok of tokens) if (hay.includes(tok)) s += 6;
      pushId(t.id, s, 'thin-upstream');
    }
  }
  for (const t of catalog) {
    if (String(t.id).startsWith('std-') && isRealTemplate(t)) pushId(t.id, 25, 'std-any');
  }

  candidates.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const seen = new Set();
  const ordered = [];
  for (const c of candidates) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    ordered.push(c);
  }
  if (!ordered.length) {
    return {
      templateId: null,
      template: null,
      match,
      network,
      reason: 'No real instantiable template available (demos excluded)',
    };
  }
  const best = ordered[0];
  return {
    templateId: best.id,
    template: best.template,
    match,
    network,
    reason: `real template «${best.id}» (${best.why}, score ${best.score}); demos excluded`,
  };
}
