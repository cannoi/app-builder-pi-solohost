#!/usr/bin/env node
/**
 * AI Repair Evaluation Harness (v1.11.0, N6).
 * Evaluates syntax-error, ui-calls-missing-api, and crash-on-start against a real AI provider
 * when GEMINI_API_KEY, DEEPSEEK_API_KEY, or OPENAI_API_KEY is configured in the environment.
 * Otherwise skips cleanly with status NOT_TESTED and writes docs/engineering/AI-REPAIR-EVAL.md.
 *
 * Usage: node scripts/eval-ai-repair.mjs [--json out.json] [--write-doc]
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runValidationPipeline } from '../src/engineering/validation/pipeline.js';
import { runVerifiedRepairLoop } from '../src/engineering/orchestrator/repair-loop.js';
import { loadConfig } from '../src/config/index.js';
import { AIGateway } from '../src/ai/gateway.js';
import { patchPrompt, SYSTEM } from '../src/ai/prompts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TPL = path.join(ROOT, 'templates', 'std-business-crm');
const DOC_OUT = path.join(ROOT, 'docs', 'engineering', 'AI-REPAIR-EVAL.md');

const CASES = [
  {
    id: 'syntax-error',
    inject: async (d) => {
      const p = path.join(d, 'src', 'server.js');
      const s = await fs.readFile(p, 'utf8');
      await fs.writeFile(p, `${s}\nconst broken = ;\n`);
    },
  },
  {
    id: 'ui-calls-missing-api',
    inject: async (d) => {
      const p = path.join(d, 'public', 'index.html');
      const h = await fs.readFile(p, 'utf8');
      await fs.writeFile(p, h.replace('</body>', "<script>fetch('/api/eval-missing-endpoint').catch(()=>{})</script></body>"));
    },
  },
  {
    id: 'crash-on-start',
    inject: async (d) => {
      const p = path.join(d, 'src', 'server.js');
      const s = await fs.readFile(p, 'utf8');
      await fs.writeFile(p, `${s}\nthrow new Error('eval crash on start');\n`);
    },
  },
];

function configuredKey() {
  return Boolean(
    String(process.env.GEMINI_API_KEY || '').trim()
    || String(process.env.DEEPSEEK_API_KEY || '').trim()
    || String(process.env.OPENAI_API_KEY || '').trim(),
  );
}

async function collectFiles(dir) {
  const out = [];
  for (const rel of ['package.json', 'src/server.js', 'public/index.html']) {
    const text = await fs.readFile(path.join(dir, rel), 'utf8').catch(() => null);
    if (text != null) out.push({ path: rel, content: text.slice(0, 12000) });
  }
  return out;
}

async function runEval() {
  const hasKey = configuredKey();
  const report = {
    at: new Date().toISOString(),
    node: process.versions.node,
    platform: `${process.platform}/${process.arch}`,
    providerConfigured: hasKey,
    status: hasKey ? 'EXECUTED' : 'NOT_TESTED',
    cases: [],
  };

  if (!hasKey) {
    for (const c of CASES) {
      report.cases.push({ id: c.id, status: 'NOT_TESTED', reason: 'No GEMINI_API_KEY / DEEPSEEK_API_KEY / OPENAI_API_KEY configured' });
    }
    console.log('NOT_TESTED: no live AI provider key configured; skipping live AI repair evaluation.');
  } else {
    const cfg = loadConfig();
    const ai = new AIGateway({ cfg, db: null, log: null });
    for (const c of CASES) {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), `eval-${c.id}-`));
      try {
        await fs.cp(TPL, dir, { recursive: true });
        await c.inject(dir);
        const validate = () => runValidationPipeline(dir, { stopOnFail: false, runtime: true, browser: false });
        const t0 = Date.now();
        const loop = await runVerifiedRepairLoop({
          sourceDir: dir,
          task: `Fix ${c.id} in the application`,
          validate,
          aiRepair: async ({ evidence }) => {
            const relevant = await collectFiles(dir);
            const r = await ai.callJson({
              task: 'DEBUGGING',
              system: SYSTEM,
              prompt: `${patchPrompt({ name: 'eval-app', idea: 'CRM app' }, 'Fix the failing validation steps.', relevant)}\n\n${evidence.text}`,
            });
            return { files: r.json?.files || [] };
          },
          applyFiles: async (files) => {
            for (const f of files || []) {
              if (!f?.path || typeof f.content !== 'string') continue;
              const full = path.resolve(dir, f.path);
              if (!full.startsWith(path.resolve(dir))) continue;
              await fs.mkdir(path.dirname(full), { recursive: true });
              await fs.writeFile(full, f.content, 'utf8');
            }
            return { checkpointId: null };
          },
          budget: { deterministic: 2, ai: 2 },
        });
        const passed = loop.status !== 'FAIL';
        report.cases.push({
          id: c.id,
          status: passed ? 'PASS' : 'FAIL',
          durationMs: Date.now() - t0,
          stopReason: loop.stopReason,
          attempts: (loop.history || []).length,
        });
        console.log(`${c.id.padEnd(22)} ${passed ? 'PASS' : 'FAIL'} (${Date.now() - t0}ms, stop=${loop.stopReason})`);
      } catch (err) {
        report.cases.push({ id: c.id, status: 'FAIL', error: String(err?.message || err).slice(0, 300) });
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  }

  const ji = process.argv.indexOf('--json');
  if (ji > 0 && process.argv[ji + 1]) await fs.writeFile(process.argv[ji + 1], JSON.stringify(report, null, 2));

  if (process.argv.includes('--write-doc')) {
    const md = [
      '# AI Repair Evaluation — v1.11.0',
      '',
      `Status: **${report.status}** · Platform: \`${report.platform}\` · Node: \`${report.node}\``,
      '',
      '| Case | Status | Detail |',
      '|---|---|---|',
      ...report.cases.map((c) => `| ${c.id} | ${c.status} | ${c.reason || c.stopReason || c.error || '—'} |`),
      '',
      'To execute against a real provider:',
      '',
      '```bash',
      'GEMINI_API_KEY=... npm run eval:ai-repair -- --write-doc --json eval-ai.json',
      '```',
      '',
    ].join('\n');
    await fs.writeFile(DOC_OUT, md, 'utf8');
  }

  return report;
}

await runEval();
