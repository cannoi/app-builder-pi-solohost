/**
 * Provider-agnostic, bounded tool-calling loop inspired by the Cline SDK runtime.
 * The host owns tools, persistence, policy and cancellation; models never execute shell commands.
 */
import { createHash } from 'node:crypto';

export const DEFAULT_AGENT_LIMITS = Object.freeze({ maxIterations: 4, maxToolCalls: 16, maxActionsPerTurn: 6 });

function actionKey(actions) {
  return createHash('sha256').update(JSON.stringify(actions || [])).digest('hex').slice(0, 20);
}

function normalizeActions(value, limit) {
  return (Array.isArray(value) ? value : [])
    .filter((item) => item && typeof item === 'object' && typeof item.tool === 'string')
    .slice(0, limit)
    .map((item) => ({ ...item, tool: String(item.tool).trim().slice(0, 80) }));
}

/**
 * Repeatedly asks the configured model for a plan, executes host-allowlisted tools,
 * and feeds their results back until the model returns a final plan or a hard limit.
 */
export async function runToolAgentLoop({
  callModel,
  executeTools,
  prompt,
  validateJson,
  onProgress = () => {},
  onMemory = async () => {},
  limits = {},
} = {}) {
  if (typeof callModel !== 'function' || typeof executeTools !== 'function') {
    throw new TypeError('runToolAgentLoop requires callModel and executeTools functions.');
  }
  const cap = { ...DEFAULT_AGENT_LIMITS, ...limits };
  const maxIterations = Math.max(1, Math.min(6, Number(cap.maxIterations) || 4));
  const maxToolCalls = Math.max(1, Math.min(24, Number(cap.maxToolCalls) || 16));
  const maxActionsPerTurn = Math.max(1, Math.min(8, Number(cap.maxActionsPerTurn) || 6));
  const transcript = [];
  const seenBatches = new Set();
  let toolCallCount = 0;
  let latest = null;
  let repeatedBatch = false;

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    onProgress({ type: 'agent_iteration', iteration, maxIterations, toolCallCount });
    latest = await callModel({
      prompt: `${prompt}${transcript.length ? `\n\nAGENT TOOL HISTORY (authoritative; do not repeat completed actions):\n${JSON.stringify(transcript).slice(0, 26000)}` : ''}\n\nAGENT LOOP: iteration ${iteration}/${maxIterations}. If more source evidence is required, return tool_actions using only the allowed tools. Otherwise return the final plan.`,
      iteration,
    });
    const json = latest?.json && typeof latest.json === 'object' ? latest.json : {};
    const actions = normalizeActions(json.tool_actions, Math.min(maxActionsPerTurn, maxToolCalls - toolCallCount));
    if (!actions.length) {
      await onMemory({ status: 'planned', toolCalls: transcript, evidence: transcript.flatMap((x) => x.results || []) });
      return { result: latest, iterations: iteration, toolCalls: toolCallCount, transcript, stopped: false };
    }

    const batchKey = actionKey(actions);
    if (seenBatches.has(batchKey)) {
      repeatedBatch = true;
      transcript.push({ iteration, actions, results: [], blocked: 'Repeated identical tool batch; stopped to prevent a no-progress loop.' });
      onProgress({ type: 'agent_guard', reason: 'repeated_tool_batch', iteration });
      break;
    }
    seenBatches.add(batchKey);

    const remaining = maxToolCalls - toolCallCount;
    if (remaining <= 0) break;
    const boundedActions = actions.slice(0, remaining);
    const results = await executeTools(boundedActions);
    toolCallCount += boundedActions.length;
    transcript.push({ iteration, actions: boundedActions, results });
    await onMemory({ status: 'running', toolCalls: transcript, evidence: transcript.flatMap((x) => x.results || []) });
    onProgress({ type: 'agent_tools_completed', iteration, count: boundedActions.length, total: toolCallCount });
    if (toolCallCount >= maxToolCalls) break;
  }

  // One final synthesis call is deliberately not granted additional tool execution.
  const stopReason = repeatedBatch ? 'repeated_tool_batch' : 'iteration_or_tool_limit';
  const final = await callModel({
    prompt: `${prompt}\n\nAGENT TOOL HISTORY (authoritative):\n${JSON.stringify(transcript).slice(0, 26000)}\n\nSTOP CONDITION: ${stopReason}. Do not request more tools. Return the best evidence-based final plan, or explain what remains unknown.`,
    iteration: maxIterations + 1,
    toolsDisabled: true,
  });
  await onMemory({ status: 'planned', toolCalls: transcript, evidence: transcript.flatMap((x) => x.results || []), nextAction: stopReason });
  return { result: final?.json ? final : latest, iterations: maxIterations, toolCalls: toolCallCount, transcript, stopped: true, stopReason };
}
