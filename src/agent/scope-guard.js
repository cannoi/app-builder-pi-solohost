/**
 * Execution scope guard — Upgrade must not invoke Build-only repair.
 * P8 exception: task-scoped repair of files touched by the current Upgrade/Orchestrator task is allowed.
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

/** Task-scoped ops allowed even in Upgrade when limited to touched files. */
const TASK_SCOPED_ALLOWED = new Set([
  'taskRepair',
  'orchestratorRepair',
  'applyTaskEdits',
  'verifyTask',
]);

/**
 * @param {string} phase
 * @param {string} operation
 * @param {{ taskScoped?: boolean, touchedFiles?: string[] }} [opts]
 */
export function assertPhaseAllows(phase, operation, opts = {}) {
  const p = String(phase || '').toLowerCase();
  const op = String(operation || '');
  if (p === PHASE.UPGRADE && BUILD_ONLY.has(op)) {
    if (opts.taskScoped && TASK_SCOPED_ALLOWED.has(op)) return true;
    // Full-project DARE/scan still blocked
    const err = new Error(
      `UPGRADE_SCOPE_VIOLATION: "${op}" is a Build-phase operation and cannot run during Upgrade. ` +
        'Upgrade changes requested behavior only; use Build for full scan/DARE/repair. ' +
        'Task-scoped repair of files this task touched is allowed via taskRepair.',
    );
    err.code = 'UPGRADE_SCOPE_VIOLATION';
    err.phase = p;
    err.operation = op;
    throw err;
  }
  return true;
}

export function isUpgradeOrigin(meta = {}) {
  return meta?.origin === 'upgrade' || meta?.phase === 'upgrade';
}

export function guardBuildOperation(operationName, fn, getPhase) {
  return async function guarded(...args) {
    const phase = typeof getPhase === 'function' ? await getPhase(...args) : getPhase;
    assertPhaseAllows(phase, operationName);
    return fn(...args);
  };
}

/** True when operation is allowed as task-scoped repair in Upgrade. */
export function allowTaskScopedRepair(phase, operation) {
  try {
    assertPhaseAllows(phase, operation, { taskScoped: true });
    return true;
  } catch {
    return TASK_SCOPED_ALLOWED.has(String(operation || ''));
  }
}
