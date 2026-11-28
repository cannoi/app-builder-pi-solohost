import { validateSchema } from './schema.js';
import { redactDeep, redactText } from '../redact.js';

const PERMISSIONS = new Set(['READ', 'WRITE_SOURCE', 'EXEC_SAFE', 'NETWORK_LOCAL', 'DESTRUCTIVE']);
const MODES = new Set(['in_process', 'child_process', 'browser', 'mcp']);

export function validateDescriptor(d) {
  const errors = [];
  if (!d || typeof d !== 'object') return ['descriptor must be an object'];
  if (!d.id || typeof d.id !== 'string' || !/^[a-z][a-z0-9_.]*$/.test(d.id)) errors.push('invalid id');
  if (!d.name) errors.push('name required');
  if (!d.category) errors.push('category required');
  if (!PERMISSIONS.has(d.permission)) errors.push('invalid permission');
  if (!MODES.has(d.mode)) errors.push('invalid mode');
  if (typeof d.handler !== 'function') errors.push('handler must be a function');
  if (!d.input || typeof d.input !== 'object') errors.push('input schema required');
  return errors;
}

export function createRegistry() {
  const tools = new Map();

  function register(descriptor) {
    const errors = validateDescriptor(descriptor);
    if (errors.length) throw new Error(`Invalid tool descriptor: ${errors.join('; ')}`);
    if (tools.has(descriptor.id)) throw new Error(`Duplicate tool id: ${descriptor.id}`);
    tools.set(descriptor.id, {
      timeoutMs: 10_000,
      retry: { max: 0, backoffMs: 0, on: [] },
      security: { pathScope: 'project', redactOutput: true, maxOutputBytes: 65536, requiresConfirmation: false },
      availability: async () => ({ status: 'available' }),
      health: async () => ({ ok: true, latencyMs: 0 }),
      ...descriptor,
    });
    return tools.get(descriptor.id);
  }

  function get(id) {
    return tools.get(id) || null;
  }

  function list() {
    return [...tools.values()].map(publicDescriptor);
  }

  function publicDescriptor(d) {
    return {
      id: d.id,
      name: d.name,
      description: d.description,
      category: d.category,
      permission: d.permission,
      mode: d.mode,
      timeoutMs: d.timeoutMs,
      input: d.input,
      output: d.output || null,
    };
  }

  async function discover(ctx = {}) {
    const out = [];
    for (const d of tools.values()) {
      let avail = { status: 'available' };
      try {
        avail = await d.availability(ctx);
      } catch (err) {
        avail = { status: 'unavailable', reason: String(err.message || err) };
      }
      out.push({ ...publicDescriptor(d), availability: avail });
    }
    return out.filter((t) => t.availability?.status === 'available');
  }

  function describeForModel(selectedIds = null) {
    const ids = selectedIds ? new Set(selectedIds) : null;
    const lines = [];
    for (const d of tools.values()) {
      if (ids && !ids.has(d.id)) continue;
      if (d.permission === 'DESTRUCTIVE' || d.permission === 'WRITE_SOURCE') continue;
      lines.push(`- ${d.id}: ${String(d.description || d.name).replace(/\s+/g, ' ').slice(0, 140)}`);
    }
    return lines.join('\n');
  }

  async function call(id, args = {}, ctx = {}) {
    const d = tools.get(id);
    if (!d) return { ok: false, status: 'FAIL', error: `Unknown tool: ${id}` };
    // Dedupe cache (M5): READ tools keyed by toolId + args + source manifest hash.
    const cacheKey = ctx.cache && ctx.manifestHash && d.permission === 'READ' ? `${id}|${JSON.stringify(args)}|${ctx.manifestHash}` : null;
    if (cacheKey && ctx.cache.has(cacheKey)) return { ...ctx.cache.get(cacheKey), cached: true };
    const inputCheck = validateSchema(d.input, args);
    if (!inputCheck.ok) {
      return { ok: false, status: 'FAIL', error: `Invalid input: ${inputCheck.errors.join('; ')}` };
    }
    let avail;
    try {
      avail = await d.availability(ctx);
    } catch (err) {
      avail = { status: 'unavailable', reason: String(err.message || err) };
    }
    if (avail?.status === 'unavailable') {
      return { ok: false, status: 'NOT_AVAILABLE', error: avail.reason || 'unavailable' };
    }
    const started = Date.now();
    const timeoutMs = Number(d.timeoutMs) || 10_000;
    try {
      const result = await Promise.race([
        d.handler(args, ctx),
        new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('Tool timeout'), { code: 'TOOL_TIMEOUT' })), timeoutMs)),
      ]);
      const durationMs = Date.now() - started;
      if (d.output) {
        const outCheck = validateSchema(d.output, result?.data ?? result);
        if (!outCheck.ok) {
          return {
            ok: false,
            status: 'FAIL',
            error: `Invalid output: ${outCheck.errors.join('; ')}`,
            durationMs,
            toolId: id,
          };
        }
      }
      const maxBytes = d.security?.maxOutputBytes || 65536;
      let data = result?.data !== undefined ? result.data : result;
      try {
        const json = JSON.stringify(data);
        if (json && json.length > maxBytes) {
          data = { truncated: true, preview: json.slice(0, maxBytes) };
        }
      } catch { /* non-serializable */ }
      const out = {
        ok: result?.ok !== false,
        status: result?.status || (result?.ok === false ? 'FAIL' : 'PASS'),
        data: d.security?.redactOutput === false ? data : redactDeep(data),
        evidence: result?.evidence || null,
        error: result?.error ? redactText(String(result.error)).slice(0, 1000) : undefined,
        durationMs,
        toolId: id,
      };
      if (cacheKey) ctx.cache.set(cacheKey, out);
      return out;
    } catch (err) {
      return {
        ok: false,
        status: err?.code === 'TOOL_TIMEOUT' ? 'FAIL' : 'FAIL',
        error: String(err.message || err).slice(0, 500),
        durationMs: Date.now() - started,
        toolId: id,
      };
    }
  }

  return { register, get, list, discover, describeForModel, call, size: () => tools.size };
}

export default { createRegistry, validateDescriptor };
