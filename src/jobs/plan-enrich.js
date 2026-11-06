/**
 * Ensure product plans carry screens, user stories, and acceptance checks (v1.8.13).
 */

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function uniqueStrings(list, max = 12) {
  const out = [];
  const seen = new Set();
  for (const x of list) {
    const s = String(x || '').trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Expand a thin plan into a minimum viable product outline without inventing
 * unrelated products — derived from idea + core_features when AI omitted fields.
 */
export function enrichPlan(plan = {}, analysis = {}, idea = '') {
  const p = plan && typeof plan === 'object' ? { ...plan } : {};
  const features = uniqueStrings([
    ...asArray(p.features).map((f) => (typeof f === 'string' ? f : f?.name)),
    ...asArray(analysis?.core_features),
  ], 8);

  if (!features.length) {
    features.push('Core task from the user idea', 'Clear status feedback');
  }

  let screens = asArray(p.screens).map((s) => {
    if (typeof s === 'string') return { id: slugify(s), title: s, purpose: s };
    return {
      id: String(s?.id || slugify(s?.title || s?.name || 'screen')).slice(0, 40),
      title: String(s?.title || s?.name || 'Screen').slice(0, 80),
      purpose: String(s?.purpose || s?.description || s?.title || '').slice(0, 160),
    };
  }).filter((s) => s.title);

  if (screens.length < 2) {
    const name = p.name || analysis?.name || 'App';
    screens = [
      { id: 'home', title: `${name} home`, purpose: 'Primary place to start the main task' },
      { id: 'main-task', title: 'Main task', purpose: features[0] || 'Complete the primary action' },
      { id: 'status', title: 'Status / list', purpose: 'See saved results and empty states' },
    ];
  }

  let user_stories = asArray(p.user_stories).map((s) => String(s?.text || s || '').trim()).filter(Boolean);
  if (user_stories.length < 2) {
    user_stories = [
      `As a user, I can open the app and understand what it does from the first screen.`,
      `As a user, I can complete: ${features[0]}.`,
      `As a user, I can see my result afterward and recover from empty or error states.`,
    ];
  }

  let acceptance_checks = asArray(p.acceptance_checks).map((s) => String(s?.text || s || '').trim()).filter(Boolean);
  if (acceptance_checks.length < 3) {
    acceptance_checks = uniqueStrings([
      ...acceptance_checks,
      'Health endpoint responds OK',
      'Home screen shows more than the app name',
      'User can perform at least one primary action (form, button, or API)',
      'Empty or error state is visible when there is no data',
      features[0] ? `Feature works: ${features[0]}` : '',
    ], 8);
  }

  if (!asArray(p.user_flow).length) {
    p.user_flow = [
      'Open the app and read the purpose',
      'Use the main action',
      'See the result or list update',
      'Retry or fix input if something fails',
    ];
  }

  if (!asArray(p.data_model).length) {
    p.data_model = [{ entity: 'item', fields: ['id', 'title', 'created_at', 'status'] }];
  }

  p.screens = screens;
  p.user_stories = user_stories;
  p.acceptance_checks = acceptance_checks;
  p.features = asArray(p.features).length
    ? p.features
    : features.map((name) => ({ name, included: true, why: 'From idea or analysis' }));
  p.enriched = true;
  p.enrichment = 'screens_stories_acceptance';
  if (!p.summary && analysis?.summary) p.summary = analysis.summary;
  if (!p.name && analysis?.name) p.name = analysis.name;
  if (idea && !p.idea) p.idea = String(idea).slice(0, 500);
  return p;
}

function slugify(s) {
  return String(s || 'screen')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'screen';
}

export function planCompleteness(plan = {}) {
  const screens = asArray(plan.screens).length;
  const stories = asArray(plan.user_stories).length;
  const checks = asArray(plan.acceptance_checks).length;
  const ok = screens >= 2 && stories >= 2 && checks >= 3;
  return {
    ok,
    screens,
    stories,
    checks,
    summary: ok
      ? `Plan ready: ${screens} screens, ${stories} stories, ${checks} acceptance checks.`
      : `Plan still thin: screens=${screens}, stories=${stories}, checks=${checks}.`,
  };
}
