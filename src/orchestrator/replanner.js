/**
 * Replan when a task is unreachable: split, switch strategy, or ask user once.
 */
export function replanAfterFailure({ plan, failedTaskId, reason = '', maxReplans = 2, replanCount = 0 }) {
  if (replanCount >= maxReplans) {
    return {
      ok: false,
      askUser: true,
      question: {
        en: `Task ${failedTaskId} could not be completed (${reason}). Choose: skip optional work, try a simpler approach, or stop.`,
        vi: `Không hoàn thành ${failedTaskId} (${reason}). Chọn: bỏ phần tùy chọn, thử cách đơn giản hơn, hoặc dừng.`,
      },
      options: ['skip', 'simplify', 'stop'],
    };
  }
  const tasks = (plan.tasks || []).map((t) => {
    if (t.id === failedTaskId) {
      return {
        ...t,
        goal: `${t.goal} — retry with simpler strategy (${reason})`.slice(0, 400),
        risk: 'medium',
      };
    }
    if ((t.depends_on || []).includes(failedTaskId)) {
      return { ...t, blocked: true };
    }
    return t;
  });
  return { ok: true, plan: { ...plan, tasks }, replanCount: replanCount + 1 };
}
