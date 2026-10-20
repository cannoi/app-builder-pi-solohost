/**
 * Read-only agent loop for Change Engine V2 (max 6 steps, 8 tools/step).
 */
import path from 'node:path';

const MAX_STEPS = 6;
const MAX_TOOLS_PER_STEP = 8;
const MAX_TOOL_CHARS = 12000;

export function truncateToolResult(text, max = MAX_TOOL_CHARS) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`;
}

export function isDuplicateCall(prev, next) {
  return JSON.stringify(prev) === JSON.stringify(next);
}

/**
 * @param tools handlers: { list_files, search_text, read_file, read_range, inspect_compose, inspect_config_options, run_check }
 */
export async function runAgentLoop({
  ai,
  prompt,
  tools,
  memory,
  ledger,
  emit = () => {},
  maxSteps = MAX_STEPS,
} = {}) {
  const steps = [];
  const seenCalls = [];
  let final = null;

  for (let step = 1; step <= maxSteps; step++) {
    emit('agent', 'running', `Change Engine step ${step}/${maxSteps}`);
    const history = steps.map((s) => ({ step: s.step, tool_calls: s.tool_calls, notes: s.notes })).slice(-4);
    const r = await ai.completeJson({
      task: 'CHANGE_ENGINE',
      system: 'You inspect code with read-only tools, then return final edits. JSON only.',
      prompt: `${prompt}\n\nHISTORY:\n${JSON.stringify(history).slice(0, 8000)}\n\nReturn {"tool_calls":[{"name":"...","args":{...}}]} or {"final":{"edits":[],"explanation":"","risk":"low"}}.`,
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
    const results = [];
    for (const call of calls) {
      const name = String(call?.name || '');
      const args = call?.args || {};
      if (isDuplicateCall(seenCalls[seenCalls.length - 1], { name, args })) {
        results.push({ name, error: 'duplicate tool call rejected' });
        continue;
      }
      seenCalls.push({ name, args });
      if (!tools?.[name] || typeof tools[name] !== 'function') {
        results.push({ name, error: `unknown or disallowed tool: ${name}` });
        continue;
      }
      try {
        const out = await tools[name](args);
        results.push({ name, result: truncateToolResult(typeof out === 'string' ? out : JSON.stringify(out)) });
      } catch (err) {
        results.push({ name, error: String(err.message || err).slice(0, 500) });
      }
    }
    steps.push({ step, tool_calls: calls.map((c) => c.name), results, notes: '' });
    if (memory?.append) await memory.append({ step, results: results.length }).catch(() => {});
    if (ledger?.record) await ledger.record({ kind: 'tools', step, names: calls.map((c) => c.name) }).catch(() => {});
    // Feed tool results back by extending steps for next prompt
    steps[steps.length - 1].toolResults = results;
  }

  if (!final) {
    return {
      ok: false,
      error: `Change Engine stopped after ${maxSteps} steps without final edits`,
      steps,
      edits: [],
    };
  }
  return { ok: true, final, steps, edits: final.edits, explanation: final.explanation, risk: final.risk };
}

/** Build read-only tools bound to a project source dir */
export function createReadOnlyTools({ sourceDir, listFiles, readFile, runStatic, runNode, runScan }) {
  return {
    async list_files({ prefix = '' } = {}) {
      const all = await listFiles(sourceDir);
      const p = String(prefix || '');
      return (all || []).filter((f) => !p || f.startsWith(p)).slice(0, 400).join('\n');
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

export default { runAgentLoop, createReadOnlyTools, truncateToolResult, isDuplicateCall, MAX_STEPS, MAX_TOOLS_PER_STEP };
