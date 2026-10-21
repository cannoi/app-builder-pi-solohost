/**
 * Bounded per-task repair with new-evidence requirement.
 */
import { repairFingerprint, shouldBlockRepeatedAction, nextRepeatState } from '../jobs/loop-guard.js';

export async function repairTask({
  ai,
  task,
  failure,
  evidence = '',
  history = null,
  provider = '',
  model = '',
  diffHash = '',
  maxAttempts = 3,
  runFix,
  emit = () => {},
} = {}) {
  let state = history;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const fp = repairFingerprint({
      feedback: `${task.id}:${failure}`,
      runtime: { error: evidence },
      provider,
      model,
      diffHash: diffHash || `attempt${attempt}`,
    });
    if (shouldBlockRepeatedAction(state, fp, Date.now(), 10 * 60_000, maxAttempts)) {
      return { ok: false, blocked: true, reason: 'NEEDS_USER_ACTION: same failure without new evidence', state };
    }
    emit('repair', 'running', `${task.id} repair ${attempt}/${maxAttempts}`);
    const result = await runFix({ attempt, fingerprint: fp, evidence });
    state = nextRepeatState(state, fp);
    if (result?.ok) return { ok: true, result, state, attempts: attempt };
    evidence = result?.evidence || evidence;
    diffHash = result?.diffHash || `attempt${attempt + 1}`;
  }
  return { ok: false, exhausted: true, state };
}
