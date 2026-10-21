/**
 * Task-scoped executor wrapping agent loop + edits.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { runAgentLoop } from '../engine/agent-loop.js';

export async function executeTask({
  ai,
  projectDir,
  task,
  tools,
  emit = () => {},
  allowWrite = true,
} = {}) {
  const prompt = `TASK ${task.id}: ${task.title || ''}\nGOAL: ${task.goal}\nFILES EXPECTED: ${(task.files_expected || []).join(', ')}\nAcceptance: ${JSON.stringify(task.acceptance || [])}\nPrefer minimal search/replace edits. Preserve paf-made-by badge.`;
  const { final, steps } = await runAgentLoop({
    ai,
    prompt,
    tools,
    emit,
    allowWrite,
    maxSteps: 10,
    hardMaxSteps: 16,
  });
  return { final, steps, taskId: task.id };
}

/** Build basic read tools over a project directory */
export function makeProjectTools(projectDir, { applyEdits } = {}) {
  return {
    async list_files({ dir = '.' } = {}) {
      const root = path.join(projectDir, dir);
      const out = [];
      async function walk(d, rel = '') {
        const ents = await fs.readdir(d, { withFileTypes: true }).catch(() => []);
        for (const e of ents) {
          if (['node_modules', '.git', 'data'].includes(e.name)) continue;
          const r = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) await walk(path.join(d, e.name), r);
          else out.push(r);
        }
      }
      await walk(root);
      return out.slice(0, 400);
    },
    async read_file({ path: rel }) {
      const full = path.join(projectDir, rel);
      const text = await fs.readFile(full, 'utf8');
      return text.slice(0, 12000);
    },
    async read_range({ path: rel, start = 1, end = 80 }) {
      const text = await fs.readFile(path.join(projectDir, rel), 'utf8');
      return text.split(/\r?\n/).slice(Math.max(0, start - 1), end).join('\n');
    },
    async search_text({ query, max = 20 }) {
      // lightweight: only scan top-level + public/
      const hits = [];
      const tools = makeProjectTools(projectDir);
      const files = await tools.list_files({});
      const re = new RegExp(String(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      for (const f of files.slice(0, 120)) {
        try {
          const t = await fs.readFile(path.join(projectDir, f), 'utf8');
          if (re.test(t)) hits.push(f);
          if (hits.length >= max) break;
        } catch { /* */ }
      }
      return hits;
    },
    async apply_edits({ edits }) {
      if (!applyEdits) throw new Error('apply_edits not configured');
      return applyEdits(edits);
    },
  };
}
