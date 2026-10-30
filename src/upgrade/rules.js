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
    execution: normalizeExecution(raw.EXECUTION || raw.execution || raw.RULE_EXECUTION || raw.ruleExecution),
    definitionOfDone: asList(raw.DEFINITION_OF_DONE || raw.DEFINITION || raw.definitionOfDone),
    userChoices: asList(raw.USER_CHOICES || raw.REQUIRED_CHOICES || raw.userChoices),
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
  return lines.join('\n');
}

export function normalizeExecution(value) {
  // Rules may omit EXECUTION entirely or explicitly provide null. Never dereference
  // a nullable execution object: the old runner crashed on `execution.maxCycles`.
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const n = (v, fallback, min, max) => {
    const x = Number(v);
    if (!Number.isFinite(x)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(x)));
  };
  return {
    autoApply: raw.AUTO_APPLY !== false && raw.autoApply !== false,
    maxCycles: n(raw.MAX_CYCLES ?? raw.maxCycles, 20, 20, 100),
    maxTasks: n(raw.MAX_TASKS ?? raw.maxTasks, 40, 1, 80),
    maxRetriesPerTask: n(raw.MAX_RETRIES_PER_TASK ?? raw.maxRetriesPerTask, 1, 0, 2),
    verifyEachTask: raw.VERIFY_EACH_TASK !== false && raw.verifyEachTask !== false,
    stopOnUserAction: raw.STOP_ON_USER_ACTION !== false && raw.stopOnUserAction !== false,
    allowMediumRisk: raw.ALLOW_MEDIUM_RISK !== false && raw.allowMediumRisk !== false,
  };
}

export function buildRuleTasks(rule, gap = null) {
  const required = Array.isArray(rule?.requiredCapabilities) ? rule.requiredCapabilities : [];
  const missing = new Set((gap?.missingCapabilities || required).map((x) => String(x).trim().toLowerCase()));
  const tasks = required.map((capability, index) => ({
    id: `cap-${index + 1}`,
    capability,
    status: missing.has(String(capability).trim().toLowerCase()) ? 'pending' : 'satisfied',
    dependsOn: index > 0 ? [`cap-${index}`] : [],
  }));
  if (rule?.definitionOfDone?.length) {
    tasks.push(...rule.definitionOfDone.map((item, index) => ({
      id: `done-${index + 1}`,
      capability: `Acceptance: ${item}`,
      status: 'pending',
      dependsOn: required.length ? [`cap-${required.length}`] : [],
      acceptance: true,
    })));
  }
  return tasks;
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
    const nested = line.match(/^\s{2,}([A-Z][A-Z0-9 _/-]{2,}):\s*(.*)$/);
    if (nested && current) {
      const key = nested[1].trim().replace(/\s+/g, '_').toUpperCase();
      const value = nested[2].trim();
      if (typeof out[current] !== 'object' || Array.isArray(out[current]) || out[current] == null) out[current] = {};
      out[current][key] = value;
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
