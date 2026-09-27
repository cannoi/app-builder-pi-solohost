const SECRET_KEYS = /api[_-]?key|token|secret|password|private[_-]?key/i;

export function parseRule(input = '') {
  const text = String(input || '').trim();
  if (!text) return { valid: false, error: 'RULE_INVALID: empty rule. Add RULE_NAME, GOAL, and REQUIRED CAPABILITIES.' };
  if (/^\s*\{/.test(text)) {
    try { return normalizeRule(JSON.parse(text), text); }
    catch (err) { return { valid: false, error: `RULE_INVALID: JSON parse error (${String(err.message || err).slice(0, 180)}).` }; }
  }
  const fields = parseLoose(text);
  return normalizeRule(fields, text);
}

export function normalizeRule(raw = {}, source = '') {
  const name = String(raw.RULE_NAME || raw.rule_name || raw.name || '').trim();
  const goal = String(raw.GOAL || raw.goal || '').trim();
  const required = asList(raw.REQUIRED_CAPABILITIES || raw.requiredCapabilities || raw.required);
  const problems = [];
  if (!name) problems.push('missing RULE_NAME');
  if (!goal) problems.push('missing GOAL');
  if (!required.length) problems.push('missing REQUIRED CAPABILITIES');
  if (containsLiveSecret(source)) problems.push('rule contains a real-looking secret; remove credentials from the file');
  if (problems.length) return { valid: false, error: `RULE_INVALID: ${problems.join('; ')}.`, raw };
  return {
    valid: true,
    name,
    version: String(raw.RULE_VERSION || raw.version || '1.0').trim(),
    appType: String(raw.APP_TYPE || raw.appType || 'GENERIC').trim(),
    goal,
    target: String(raw.TARGET || raw.target || 'PI_SOLOHOST').trim(),
    requiredCapabilities: required,
    optionalCapabilities: asList(raw.OPTIONAL_CAPABILITIES || raw.optionalCapabilities),
    secrets: asSecrets(raw.REQUIRED_SECRETS || raw.SECRETS || raw.secrets),
    functionalTests: asList(raw.FUNCTIONAL_ACCEPTANCE || raw.FUNCTIONAL_TEST || raw.functionalTests),
    phases: asPhases(raw.PHASES || raw.STEPS || raw.phases || raw.steps),
    questions: asQuestions(raw.QUESTIONS || raw.USER_QUESTIONS || raw.questions),
    stopConditions: asList(raw.STOP_CONDITIONS || raw.stopConditions),
    maxCycles: clampCycles(raw.MAX_CYCLES || raw.maxCycles),
    autoRepair: raw.AUTO_REPAIR !== false && raw.autoRepair !== false,
    source,
  };
}

export function capabilityGap(rule, sourceText = '') {
  const hay = String(sourceText || '').toLowerCase();
  const current = [];
  const missing = [];
  for (const cap of rule.requiredCapabilities || []) {
    const tokens = String(cap).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
    const hit = tokens.length ? tokens.some((token) => hay.includes(token)) : false;
    (hit ? current : missing).push(cap);
  }
  return {
    currentCapabilities: current,
    missingCapabilities: missing,
    brokenCapabilities: [],
    complete: missing.length === 0,
  };
}

export function formatRuleStatus(rule, gap) {
  const lines = [
    `🧭 Rule loaded: ${rule.name} v${rule.version}`,
    `Goal: ${rule.goal}`,
    `Required: ${(rule.requiredCapabilities || []).join(', ') || '—'}`,
    gap.missingCapabilities.length ? `Missing: ${gap.missingCapabilities.join(', ')}` : 'Required capabilities look present in source.',
  ];
  if (rule.secrets?.some((s) => s.required)) lines.push(`🔑 Required configuration: ${rule.secrets.filter((s) => s.required).map((s) => s.name).join(', ')}`);
  if (rule.phases?.length) lines.push(`Steps: ${rule.phases.map((p) => p.name).join(' → ')}`);
  lines.push(`Mode: ${rule.autoRepair ? 'bounded auto-repair' : 'guided'} · Max cycles: ${rule.maxCycles}`);
  return lines.join('\n');
}

function parseLoose(text) {
  const out = {};
  let current = null;
  const lines = text.replace(/\r/g, '').split('\n');
  for (const line of lines) {
    const heading = line.match(/^#{1,3}\s+(.+)/) || line.match(/^([A-Z][A-Z0-9 _/-]{2,}):\s*(.*)$/);
    if (heading && !line.startsWith('-')) {
      current = heading[1].trim().replace(/\s+/g, '_').toUpperCase();
      out[current] = heading[2] ? heading[2].trim() : (out[current] || '');
      continue;
    }
    const item = line.match(/^\s*[-*]\s+(.+)/);
    if (item && current) {
      const prev = out[current];
      out[current] = Array.isArray(prev) ? [...prev, item[1].trim()] : (prev ? [String(prev), item[1].trim()].filter(Boolean) : [item[1].trim()]);
      continue;
    }
    if (current && line.trim()) {
      const prev = out[current];
      out[current] = prev ? `${prev}\n${line.trim()}` : line.trim();
    }
  }
  return out;
}

function asList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).replace(/^[-*]\s*/, '').trim()).filter(Boolean);
  return String(value || '').split(/\n|;/).map((v) => v.replace(/^[-*]\s*/, '').trim()).filter((v) => v && !/^={3,}/.test(v));
}

function asSecrets(value) {
  if (Array.isArray(value)) return value.map((s) => (typeof s === 'string' ? { name: s, required: true } : { name: s.name || s.SECRET || s.SECRET_NAME, purpose: s.PURPOSE || s.purpose || '', required: s.REQUIRED !== false && s.required !== false }));
  const text = String(value || '');
  const names = [...text.matchAll(/\b([A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET))\b/g)].map((m) => m[1]);
  return [...new Set(names)].map((name) => ({ name, required: true }));
}

function containsLiveSecret(text) {
  return SECRET_KEYS.test(text) && /(?:sk-|AIza|ghp_|xai-|Bearer\s+[A-Za-z0-9._-]{20,})/.test(text);
}


function asPhases(value) {
  if (Array.isArray(value)) return value.map((v, i) => {
    if (typeof v === 'string') return { name: v.trim(), goal: v.trim(), order: i + 1 };
    return { name: String(v?.name || v?.NAME || `Step ${i + 1}`).trim(), goal: String(v?.goal || v?.GOAL || v?.description || '').trim(), verify: asList(v?.verify || v?.VERIFY), order: i + 1 };
  }).filter((v) => v.name);
  return asList(value).map((name, i) => ({ name, goal: name, order: i + 1 }));
}

function asQuestions(value) {
  if (Array.isArray(value)) return value.map((v) => typeof v === 'string' ? { id: v, prompt: v, required: true, options: [] } : {
    id: String(v?.id || v?.ID || v?.name || v?.NAME || '').trim(),
    prompt: String(v?.prompt || v?.PROMPT || v?.question || v?.QUESTION || '').trim(),
    required: v?.required !== false && v?.REQUIRED !== false,
    options: asList(v?.options || v?.OPTIONS),
  }).filter((v) => v.id || v.prompt);
  return asList(value).map((prompt, i) => ({ id: `question_${i + 1}`, prompt, required: true, options: [] }));
}

function clampCycles(value) {
  const n = Number(value || 3);
  return Number.isFinite(n) ? Math.max(1, Math.min(6, Math.floor(n))) : 3;
}
