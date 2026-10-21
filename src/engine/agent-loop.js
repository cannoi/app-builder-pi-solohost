/**
 * Agent loop for Change Engine / Orchestrator.
 * P0 fix: history includes tool results (newest full, older truncated).
 * P1 fix: global dedupe (cached result, not only previous call); progress-based soft budget.
 */
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_STEPS_SOFT = 8;
const MAX_STEPS_HARD = 16;
const MAX_TOOLS_PER_STEP = 8;
const MAX_TOOL_CHARS = 12000;
const MAX_HISTORY_CHARS = 24000;

export function truncateToolResult(text, max = MAX_TOOL_CHARS) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`;
}

export function callKey(name, args) {
  return crypto.createHash('sha1').update(JSON.stringify({ name, args })).digest('hex');
}

export function isDuplicateCall(prev, next) {
  return JSON.stringify(prev) === JSON.stringify(next);
}

/**
 * Build HISTORY payload that keeps tool results so the model can use them.
 * Newest step results kept in full (truncated per tool); older steps summarised.
 */
export function buildHistoryForPrompt(steps, { maxChars = MAX_HISTORY_CHARS } = {}) {
  const out = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const isRecent = i >= steps.length - 2;
    if (s.final) {
      out.push({ step: s.step, final: true, notes: s.notes || '' });
      continue;
    }
    const entry = {
      step: s.step,
      tool_calls: (s.tool_calls || []).map((c) => ({ name: c.name, args: c.args })),
      results: (s.results || []).map((r) => {
        if (r.error) return { name: r.name, error: r.error };
        const text = isRecent ? truncateToolResult(r.result, MAX_TOOL_CHARS) : truncateToolResult(r.result, 2000);
        return { name: r.name, result: text };
      }),
      notes: s.notes || '',
    };
    out.push(entry);
  }
  let json = JSON.stringify(out);
  while (json.length > maxChars && out.length > 1) {
    out.shift();
    json = JSON.stringify(out);
  }
  return out;
}

/**
 * @param tools handlers including optional write tools: apply_edits, create_file, delete_file
 */
export async function runAgentLoop({
  ai,
  prompt,
  tools,
  memory,
  ledger,
  emit = () => {},
  maxSteps = MAX_STEPS_SOFT,
  hardMaxSteps = MAX_STEPS_HARD,
  allowWrite = false,
} = {}) {
  const steps = [];
  const callCache = new Map(); // key -> result payload
  const seenKeys = new Set();
  let final = null;
  let consecutiveNoProgress = 0;
  let limit = Math.min(Number(maxSteps) || MAX_STEPS_SOFT, hardMaxSteps);

  for (let step = 1; step <= limit; step++) {
    emit('agent', 'running', `Agent step ${step}/${limit}`);
    const history = buildHistoryForPrompt(steps);
    const r = await ai.completeJson({
      task: 'CHANGE_ENGINE',
      system: allowWrite
        ? 'You inspect and edit code with tools, then return final edits. JSON only. Use tool results from HISTORY.'
        : 'You inspect code with tools, then return final edits. JSON only. Use tool results from HISTORY.',
      prompt: `${prompt}\n\nHISTORY (includes tool results):\n${JSON.stringify(history)}\n\nReturn {"tool_calls":[{"name":"...","args":{...}}]} or {"final":{"edits":[],"explanation":"","risk":"low"}}.`,
    });
    const json = r?.json || {};
    if (json.final && (Array.isArray(json.final.edits) || json.final.edits === undefined)) {
      final = {
        edits: Array.isArray(json.final.edits) ? json.final.edits : [],
        explanation: String(json.final.explanation || ''),
        risk: String(json.final.risk || 'medium').toLowerCase(),
      };
      steps.push({ step, final: true, notes: final.explanation });
      if (ledger?.record) await ledger.record({ kind: 'final', step, explanation: final.explanation }).catch(() => {});
      break;
    }

    const calls = Array.isArray(json.tool_calls) ? json.tool_calls.slice(0, MAX_TOOLS_PER_STEP) : [];
    if (!calls.length) {
      consecutiveNoProgress += 1;
      steps.push({ step, tool_calls: [], results: [], notes: 'empty tool_calls' });
      if (consecutiveNoProgress >= 2) {
        emit('agent', 'failed', 'No progress: empty tool calls twice');
        break;
      }
      continue;
    }

    const results = [];
    let madeProgress = false;
    for (const call of calls) {
      const name = String(call?.name || '');
      const args = call?.args || {};
      const key = callKey(name, args);
      if (callCache.has(key)) {
        const cached = callCache.get(key);
        results.push({
          name,
          result: typeof cached === 'string' ? cached : JSON.stringify(cached),
          cached: true,
          note: 'already read — same call earlier in this loop',
        });
        continue;
      }
      if (!tools?.[name] || typeof tools[name] !== 'function') {
        results.push({ name, error: `unknown tool: ${name}` });
        continue;
      }
      if (!allowWrite && ['apply_edits', 'create_file', 'delete_file'].includes(name)) {
        results.push({ name, error: 'write tools disabled in this loop' });
        continue;
      }
      try {
        const out = await tools[name](args);
        const text = truncateToolResult(typeof out === 'string' ? out : JSON.stringify(out));
        callCache.set(key, text);
        seenKeys.add(key);
        results.push({ name, result: text });
        madeProgress = true;
      } catch (err) {
        results.push({ name, error: String(err?.message || err).slice(0, 500) });
      }
    }

    steps.push({
      step,
      tool_calls: calls.map((c) => ({ name: c.name, args: c.args })),
      results,
      notes: madeProgress ? 'progress' : 'no-new-data',
    });
    if (ledger?.record) await ledger.record({ kind: 'tools', step, count: calls.length }).catch(() => {});

    if (!madeProgress) {
      consecutiveNoProgress += 1;
      if (consecutiveNoProgress >= 2) {
        emit('agent', 'failed', 'No progress: repeated tool results');
        break;
      }
    } else {
      consecutiveNoProgress = 0;
      // Soft extend while making progress
      if (step >= limit && limit < hardMaxSteps) {
        limit = Math.min(limit + 2, hardMaxSteps);
      }
    }
  }

  if (!final) {
    final = { edits: [], explanation: steps.length ? 'stopped without final edits' : 'no steps', risk: 'medium' };
  }
  if (memory?.append) {
    await memory.append({ kind: 'agent-loop', steps: steps.length, edits: final.edits?.length || 0 }).catch(() => {});
  }
  return { final, steps, pathHint: path.basename };
}

export { MAX_STEPS_SOFT as MAX_STEPS, MAX_TOOLS_PER_STEP, MAX_TOOL_CHARS };


/**
 * Read-only tools for Change Engine V2 / Modify Engine.
 */
export function createReadOnlyTools({ sourceDir, listFiles, readFile, runStatic, runNode, runScan }) {
  return {
    async list_files({ prefix = '' } = {}) {
      const all = await listFiles(sourceDir);
      const pfx = String(prefix || '');
      return (all || []).filter((f) => !pfx || f.startsWith(pfx)).slice(0, 400).join('\n');
    },
    async search_text({ query, max = 30 } = {}) {
      const q = String(query || '');
      if (!q) return '';
      const files = await listFiles(sourceDir);
      const hits = [];
      for (const rel of files.slice(0, 200)) {
        if (/\.(png|jpg|jpeg|gif|webp|ico|zip|gz)$/i.test(rel)) continue;
        let text = '';
        try { text = await readFile(path.join(sourceDir, rel)); } catch { continue; }
        if (text.includes(q)) {
          const lines = text.split('\n');
          for (let i = 0; i < lines.length && hits.length < max; i++) {
            if (lines[i].includes(q)) hits.push(`${rel}:${i + 1}:${lines[i].trim().slice(0, 200)}`);
          }
        }
        if (hits.length >= max) break;
      }
      return hits.join('\n');
    },
    async read_file({ path: rel } = {}) {
      return await readFile(path.join(sourceDir, String(rel || '')));
    },
    async read_range({ path: rel, start = 1, end = 80 } = {}) {
      const text = await readFile(path.join(sourceDir, String(rel || '')));
      const lines = String(text).split('\n');
      const a = Math.max(1, Number(start) || 1);
      const b = Math.min(lines.length, Number(end) || a + 80);
      return lines.slice(a - 1, b).map((l, i) => `${a + i}|${l}`).join('\n');
    },
    async inspect_compose() {
      try { return await readFile(path.join(sourceDir, 'docker-compose.yml')); }
      catch { return '(no docker-compose.yml)'; }
    },
    async inspect_config_options() {
      try { return await readFile(path.join(sourceDir, 'config_options.yml')); }
      catch { return '(no config_options.yml)'; }
    },
    async run_check({ type = 'static' } = {}) {
      if (type === 'node' && runNode) return JSON.stringify(await runNode());
      if (type === 'scan' && runScan) return JSON.stringify(await runScan());
      if (runStatic) return JSON.stringify(await runStatic());
      return '{"status":"skipped"}';
    },
  };
}
