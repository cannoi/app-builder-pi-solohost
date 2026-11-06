/**
 * Pure SoloHost field-policy gate. No I/O except optional loaders injected via deps.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { loadFieldPolicy, saveFieldPolicy } from './solohost-fields.js';

/**
 * @param {{
 *   projectDir: string,
 *   payload?: object,
 *   existingPackage?: boolean,
 *   upgradeOrigin?: boolean,
 * }} opts
 * @returns {Promise<{ policy: object|null, needsChoice: boolean, acceptUnverified: boolean, hostPort: number|null }>}
 */
export async function resolveFieldPolicy({
  projectDir,
  payload = {},
  existingPackage = false,
  upgradeOrigin = false,
} = {}) {
  const metaDir = path.join(projectDir, 'metadata');
  let policy = null;
  try {
    policy = await loadFieldPolicy(metaDir);
  } catch {
    policy = null;
  }

  // Explicit payload wins
  if (payload?.fieldPolicy && typeof payload.fieldPolicy === 'object') {
    policy = {
      mode: payload.fieldPolicy.mode || 'full',
      fields: payload.fieldPolicy.fields || {},
      fixedValues: payload.fieldPolicy.fixedValues || {},
    };
  } else if (payload?.fieldMode) {
    policy = {
      mode: String(payload.fieldMode),
      fields: payload.fields || {},
      fixedValues: payload.fixedValues || {},
    };
  }

  // Upgrade-origin or existing solohost package: default to full, never block
  if (!policy && (upgradeOrigin || existingPackage)) {
    policy = { mode: 'full', fields: {}, fixedValues: {} };
    try {
      await saveFieldPolicy(metaDir, { ...policy, updatedAt: new Date().toISOString(), source: 'upgrade-default' });
    } catch { /* best-effort */ }
  }

  const needsChoice = !policy;
  return {
    policy: policy || null,
    needsChoice,
    acceptUnverified: payload?.acceptUnverified === true,
    hostPort: payload?.hostPort != null ? Number(payload.hostPort) : null,
  };
}

/**
 * Detect existing solohost package on disk.
 */
export async function hasExistingSoloHostPackage(sourceDir) {
  try {
    const compose = await fs.readFile(path.join(sourceDir, 'solohost', 'docker-compose.yml'), 'utf8');
    return Boolean(compose && compose.trim());
  } catch {
    try {
      const compose = await fs.readFile(path.join(sourceDir, 'docker-compose.yml'), 'utf8');
      return Boolean(compose && /pi\.ui\.primary/.test(compose));
    } catch {
      return false;
    }
  }
}

export default { resolveFieldPolicy, hasExistingSoloHostPackage };
