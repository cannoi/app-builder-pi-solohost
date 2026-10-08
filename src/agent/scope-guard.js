/**
 * Execution scope guard — Upgrade must not invoke Build-only repair.
 * Phase: upgrade | build | publish
 */
export const PHASE = Object.freeze({
  UPGRADE: 'upgrade',
  BUILD: 'build',
  PUBLISH: 'publish',
});

const BUILD_ONLY = new Set([
  'scanProject',
  'runDare',
  'autoRepair',
  'securityRepair',
  'runtimeRepair',
  'fullSecurityScan',
  'releaseValidationRepair',
]);

/**
 * @param {string} phase
 * @param {string} operation
 * @throws {{ code: 'UPGRADE_SCOPE_VIOLATION' }}
 */
export function assertPhaseAllows(phase, operation) {
  const p = String(phase || '').toLowerCase();
  const op = String(operation || '');
  if (p === PHASE.UPGRADE && BUILD_ONLY.has(op)) {
    const err = new Error(
      `UPGRADE_SCOPE_VIOLATION: "${op}" is a Build-phase operation and cannot run during Upgrade. ` +
        'Upgrade changes requested behavior only; use Build for scan/DARE/repair.',
    );
    err.code = 'UPGRADE_SCOPE_VIOLATION';
    err.phase = p;
    err.operation = op;
    throw err;
  }
  return true;
}

/** True when project metadata marks upgrade origin. */
export function isUpgradeOrigin(meta = {}) {
  return meta?.origin === 'upgrade' || meta?.phase === 'upgrade';
}

/**
 * Wrap a Build-only function so Upgrade origin projects cannot call it.
 */
export function guardBuildOperation(operationName, fn, getPhase) {
  return async function guarded(...args) {
    const phase = typeof getPhase === 'function' ? await getPhase(...args) : getPhase;
    assertPhaseAllows(phase, operationName);
    return fn(...args);
  };
}
