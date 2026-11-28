/**
 * READ tools — adapters over src/ai/agent-tools.js (parity with Upgrade).
 */
import { runAgentTools } from '../../../ai/agent-tools.js';
import { STATUS } from '../../validation/status.js';

function mapAgentResult(tool, row) {
  if (!row) return { ok: false, status: STATUS.FAIL, data: null };
  return {
    ok: row.ok !== false,
    status: row.ok === false ? STATUS.FAIL : STATUS.PASS,
    data: row,
    evidence: { tool, source: 'agent-tools' },
  };
}

async function adapt(sourceDir, tool, args) {
  const actions = [{ tool, ...args }];
  const out = await runAgentTools({ sourceDir, actions });
  return mapAgentResult(tool, out[0]);
}

export function registerReadTools(registry) {
  const src = (ctx) => ctx?.sourceDir || ctx?.projectSourceDir;
  const needSrc = (ctx) => {
    if (!src(ctx)) throw new Error('sourceDir required in tool context');
    return src(ctx);
  };

  registry.register({
    id: 'fs.list',
    name: 'List files',
    description: 'List project files (excludes node_modules, .git, secrets).',
    category: 'project_intel',
    permission: 'READ',
    mode: 'in_process',
    timeoutMs: 15_000,
    input: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (_args, ctx) => adapt(needSrc(ctx), 'list_files', {}),
  });

  registry.register({
    id: 'fs.search_text',
    name: 'Search text',
    description: 'Search project text files for a query string.',
    category: 'project_intel',
    permission: 'READ',
    mode: 'in_process',
    timeoutMs: 20_000,
    input: {
      type: 'object',
      required: ['query'],
      properties: { query: { type: 'string', minLength: 1, maxLength: 500 } },
      additionalProperties: false,
    },
    handler: async (args, ctx) => adapt(needSrc(ctx), 'search_text', { query: args.query }),
  });

  registry.register({
    id: 'fs.read_file',
    name: 'Read file',
    description: 'Read a project text file (size-capped, no symlinks).',
    category: 'project_intel',
    permission: 'READ',
    mode: 'in_process',
    timeoutMs: 10_000,
    input: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', minLength: 1 },
        startLine: { type: 'integer', minimum: 1 },
        endLine: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => adapt(needSrc(ctx), 'read_file', args),
  });

  registry.register({
    id: 'fs.read_range',
    name: 'Read file range',
    description: 'Read a line range from a project file.',
    category: 'project_intel',
    permission: 'READ',
    mode: 'in_process',
    timeoutMs: 10_000,
    input: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', minLength: 1 },
        startLine: { type: 'integer', minimum: 1 },
        endLine: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => adapt(needSrc(ctx), 'read_range', args),
  });

  registry.register({
    id: 'intel.config',
    name: 'Inspect package/compose/config',
    description: 'Inspect package.json and SoloHost compose/config_options when present.',
    category: 'project_intel',
    permission: 'READ',
    mode: 'in_process',
    timeoutMs: 15_000,
    input: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['package', 'compose', 'config_options', 'all'] },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      const sourceDir = needSrc(ctx);
      const target = args.target || 'all';
      const data = {};
      if (target === 'package' || target === 'all') {
        data.package = await adapt(sourceDir, 'inspect_package', {});
      }
      if (target === 'compose' || target === 'all') {
        data.compose = await adapt(sourceDir, 'inspect_compose', {});
      }
      if (target === 'config_options' || target === 'all') {
        data.config_options = await adapt(sourceDir, 'inspect_config_options', {});
      }
      return { ok: true, status: STATUS.PASS, data };
    },
  });
}
