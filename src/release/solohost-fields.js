/**
 * SoloHost install-form field inventory and policy (keep | fixed | omit).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const AUTH_RE = /ADMIN|PASSWORD|LOGIN|ACCESS|USERNAME|^USER$|AUTH|GATEWAY.*TOKEN|ACCESS_TOKEN|BUILDER_ACCESS/i;
const CRED_RE = /API_KEY|TOKEN|SECRET|CREDENTIAL|PRIVATE_KEY|MASTER_KEY/i;
const FEATURE_RE = /ENABLE|DISABLE|PROVIDER|MODEL|MODE|FEATURE|FLAG/i;
const TUNING_RE = /TIMEOUT|LIMIT|INTERVAL|CONCURRENT|RATE|LOG|DEBUG|RETRY|TTL|PARALLEL|CTX|PREDICT/i;
const INTERNAL_RE = /^(PORT|HOST|HOSTNAME|HOME|PATH|PWD|NODE_ENV|DATA_DIR|SERVICE_NAME|npm_|SHLVL|_)/i;

export function classifyVar(name) {
  const n = String(name || '');
  if (INTERNAL_RE.test(n)) return 'internal';
  if (AUTH_RE.test(n)) return 'auth';
  if (CRED_RE.test(n)) return 'credential';
  if (FEATURE_RE.test(n)) return 'feature';
  if (TUNING_RE.test(n)) return 'tuning';
  return 'feature';
}

export function isSecretName(name) {
  return /PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE|CREDENTIAL|MASTER_KEY/i.test(String(name || ''));
}

export function inventoryFields(envVars = [], extras = {}) {
  const defaults = extras.defaults || {};
  const descriptions = extras.descriptions || {};
  return [...new Set(envVars)].filter(Boolean).sort().map((name) => {
    const cls = classifyVar(name);
    const secret = isSecretName(name);
    const defaultValue = defaults[name] ?? null;
    const core = cls === 'credential' && (defaultValue == null || defaultValue === '');
    return {
      name,
      class: cls,
      secret,
      core: !!core,
      required: cls === 'auth',
      defaultValue,
      description: descriptions[name] || humanize(name),
      source: extras.sources?.[name] || 'compose',
      confidence: 'heuristic',
    };
  });
}

function humanize(name) {
  return String(name).toLowerCase().split('_').map((x) => (x ? x[0].toUpperCase() + x.slice(1) : x)).join(' ');
}

/**
 * Suggest policy. Internal never appears as keep in the form.
 * Returns { mode, fields, fixedValues, needs_confirmation? }
 */
export function suggestPolicy(inventory, mode = 'full') {
  const fields = {};
  const fixedValues = {};
  const needs_confirmation = [];

  for (const item of inventory) {
    const n = item.name;
    if (item.class === 'internal') {
      if (item.defaultValue != null && !item.secret) {
        fields[n] = 'fixed';
        fixedValues[n] = String(item.defaultValue);
      } else {
        fields[n] = 'omit';
      }
      continue;
    }

    if (mode === 'full') {
      fields[n] = 'keep';
    } else if (mode === 'defaults') {
      fields[n] = 'omit';
    } else if (mode === 'auth') {
      if (item.class === 'auth') fields[n] = 'keep';
      else if (item.core) {
        fields[n] = 'omit';
        needs_confirmation.push({
          name: n,
          reason: 'core_credential',
          messageKey: 'solohost.fields.confirm_core_credential',
          params: { name: n },
        });
      } else fields[n] = 'omit';
    } else {
      // custom suggestions
      if (item.class === 'auth' || item.class === 'credential') fields[n] = 'keep';
      else if (item.class === 'tuning') fields[n] = 'omit';
      else fields[n] = 'keep';
    }

    if (item.secret && fixedValues[n]) delete fixedValues[n];
    if (item.secret && fields[n] === 'fixed') fields[n] = 'keep';
  }

  const out = { mode, fields, fixedValues };
  if (needs_confirmation.length) out.needs_confirmation = needs_confirmation;
  return out;
}

export function applyPolicyToVars(envVars, policy) {
  const mode = policy?.mode || 'full';
  const map = policy?.fields || {};
  const fixedValues = { ...(policy?.fixedValues || {}) };
  const keep = [];
  const fixed = [];
  const omit = [];

  for (const name of envVars) {
    let treatment = map[name];
    if (!treatment) {
      if (INTERNAL_RE.test(name)) treatment = 'omit';
      else if (mode === 'full') treatment = 'keep';
      else if (mode === 'defaults') treatment = 'omit';
      else if (mode === 'auth') treatment = AUTH_RE.test(name) ? 'keep' : 'omit';
      else treatment = 'keep';
    }
    // internal never keep as form field
    if (INTERNAL_RE.test(name) && treatment === 'keep') treatment = 'omit';

    if (treatment === 'keep') keep.push(name);
    else if (treatment === 'fixed') {
      fixed.push(name);
      if (isSecretName(name)) {
        delete fixedValues[name];
        keep.push(name); // demote to keep
      }
    } else {
      omit.push(name);
    }
  }
  for (const k of Object.keys(fixedValues)) {
    if (isSecretName(k)) delete fixedValues[k];
  }
  return { keep, fixed, omit, fixedValues, mode };
}

export function policyHash(inventory) {
  const names = inventory.map((i) => i.name).sort().join(',');
  return crypto.createHash('sha256').update(names).digest('hex').slice(0, 16);
}

export async function loadFieldPolicy(metaDir) {
  try {
    const raw = await fs.readFile(path.join(metaDir, 'solohost-field-policy.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function saveFieldPolicy(metaDir, policy) {
  await fs.mkdir(metaDir, { recursive: true });
  await fs.writeFile(path.join(metaDir, 'solohost-field-policy.json'), JSON.stringify(policy, null, 2));
}

export function validatePolicyBody(body) {
  const mode = String(body?.mode || 'full');
  if (!['full', 'defaults', 'auth', 'custom'].includes(mode)) {
    throw new Error('mode must be full|defaults|auth|custom');
  }
  const fields = body?.fields || {};
  for (const [k, v] of Object.entries(fields)) {
    if (!['keep', 'fixed', 'omit'].includes(v)) {
      throw new Error(`Invalid treatment for ${k}: ${v}`);
    }
  }
  const fixedValues = body?.fixedValues || {};
  for (const k of Object.keys(fixedValues)) {
    if (isSecretName(k)) throw new Error(`Secrets cannot be fixed: ${k}`);
  }
  return { mode, fields, fixedValues };
}

export default {
  classifyVar,
  inventoryFields,
  suggestPolicy,
  applyPolicyToVars,
  policyHash,
  loadFieldPolicy,
  saveFieldPolicy,
  isSecretName,
  validatePolicyBody,
};
