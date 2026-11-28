/**
 * Multi-phase code generation (Builder 1.8.14 / roadmap 1.10+).
 * Phase 1 skeleton → Phase 2 product UI/API → Phase 3 polish/acceptance.
 * Includes syntax validation + targeted single repair, and isolates Phase 3/enrich
 * failures so valid Phase 1+2 product files are never discarded.
 */
import { SYSTEM } from '../ai/prompts.js';
import { fewShotBlock } from '../ai/few-shot-examples.js';
import { languageInstruction } from '../ai/language.js';
import { writeGeneratedFiles } from '../projects/generator.js';
import { listFiles } from '../utils/fsx.js';
import { evaluateProductDepth } from './product-checklist.js';
import { syntaxCheckFiles, describeSyntaxErrors } from './syntax-check.js';

const validateFiles = (v) => Array.isArray(v?.files) && v.files.some((f) => f && typeof f.path === 'string' && typeof f.content === 'string');

function phasePrompt(project, plan, phase, existingFiles = [], langOpts = {}) {
  const lang = languageInstruction(project.idea || project.name || '', langOpts);
  const screens = JSON.stringify(plan?.screens || [], null, 0);
  const stories = JSON.stringify(plan?.user_stories || [], null, 0);
  const checks = JSON.stringify(plan?.acceptance_checks || [], null, 0);
  const existing = existingFiles.slice(0, 40).join(', ') || '(none yet)';

  if (phase === 1) {
    return `${lang}

PHASE 1/3 — SKELETON (SoloHost-ready base only)
Project: ${project.name}
Idea: ${project.idea}

Return JSON {"files":[{"path":"...","content":"..."}],"notes":"..."}
Create only foundation files:
- package.json (start + test)
- server.js (or src/server.js) listening on process.env.PORT||8080, GET /health
- Dockerfile EXPOSE 8080, non-root if practical
- .gitignore, .env.example
Do not implement full product UI yet. Keep files minimal but valid.
`;
  }

  if (phase === 2) {
    return `${lang}

PHASE 2/3 — PRODUCT (main user value)
Project: ${project.name}
Idea: ${project.idea}
Plan screens: ${screens}
User stories: ${stories}
Already present files: ${existing}

${fewShotBlock()}

Return JSON {"files":[{"path":"...","content":"..."}],"notes":"..."}
Implement the real product:
- UI for the plan screens (home + main task minimum; all visible UI strings in the resolved target language)
- API routes needed by the stories
- Wire frontend to backend (fetch forms/buttons)
- Persist simply (data/ JSON or sqlite) when the idea needs memory
You may overwrite skeleton files. No title-only pages. Ensure all JS and HTML inline scripts are syntactically valid.
`;
  }

  return `${lang}

PHASE 3/3 — POLISH + ACCEPTANCE
Project: ${project.name}
Acceptance checks: ${checks}
Present files: ${existing}

Return JSON {"files":[{"path":"...","content":"..."}],"notes":"..."}
Add/adjust only what is missing:
- Empty and error states in UI (in the resolved target language)
- README.md short "how to use"
- tests that hit /health (and one product path if easy)
- docker-compose.yml + config_options.yml SoloHost-safe if missing
Do not remove working product behavior from phase 2.
`;
}

async function validateAndRepairPhaseFiles({ ai, project, files, label }) {
  const check = await syntaxCheckFiles(files).catch(() => ({ ok: true, errors: [] }));
  if (check.ok) return files;
  const desc = describeSyntaxErrors(check.errors);
  try {
    const repair = await ai.completeJson({
      task: 'DEBUGGING',
      system: SYSTEM,
      projectId: project.id,
      validateJson: validateFiles,
      prompt: `Fix ONLY the syntax errors reported below in ${label}. Return complete corrected JSON {"files":[{"path":"...","content":"..."}]} for ONLY the broken files.\n\nSYNTAX ERRORS:\n${desc}\n\nBROKEN FILES:\n${JSON.stringify(files.filter((f) => check.errors.some((e) => e.path === f.path)).slice(0, 4))}`,
    });
    const repairedByPath = new Map(repair.json.files.map((f) => [f.path, f]));
    const merged = files.map((f) => repairedByPath.get(f.path) || f);
    const recheck = await syntaxCheckFiles(merged).catch(() => ({ ok: true, errors: [] }));
    if (recheck.ok) return merged;
    // Strip still-broken optional files if healthy files remain, rather than writing broken syntax
    const broken = new Set(recheck.errors.map((e) => e.path));
    const safe = merged.filter((f) => !broken.has(f.path));
    return safe.length ? safe : merged;
  } catch {
    return files;
  }
}

/**
 * @returns {{ files: string[], phases: object[], fallback: boolean }}
 */
export async function generateCodeMultiPhase({
  ai,
  project,
  plan,
  dest,
  emit = () => {},
  allowFallback = false,
  singleShotPrompt = null,
  evidenceFor = null,
  langOpts = {},
}) {
  const phases = [];
  let written = [];
  let lastError = null;

  const runPhase = async (n, label) => {
    emit('code', 'running', label);
    const existing = await listFiles(dest).catch(() => []);
    const evidence = evidenceFor && n > 1 ? await evidenceFor(n).catch(() => '') : '';
    const prompt = phasePrompt(project, plan, n, existing, langOpts) + (evidence || '');
    const r = await ai.completeJson({
      task: 'CODING',
      system: SYSTEM,
      prompt,
      projectId: project.id,
      validateJson: validateFiles,
    });
    const checkedFiles = await validateAndRepairPhaseFiles({ ai, project, files: r.json.files, label: `Phase ${n}` });
    const paths = await writeGeneratedFiles(dest, checkedFiles);
    written = [...new Set([...written, ...paths])];
    phases.push({ phase: n, files: paths, notes: r.json.notes || '', provider: r.provider || null });
    return paths;
  };

  try {
    await runPhase(1, 'Phase 1/3 — foundation (server, health, Docker)…');
    await runPhase(2, 'Phase 2/3 — product UI and API…');

    // Phase 3 & enrichment are isolated so a transient error here never discards valid Phase 1+2 files
    try {
      await runPhase(3, 'Phase 3/3 — polish and acceptance…');
    } catch (phase3Err) {
      phases.push({ phase: 3, skipped: true, warning: String(phase3Err?.message || phase3Err).slice(0, 240) });
    }

    const depth = await evaluateProductDepth(dest, { name: project.name, idea: project.idea });
    if (!depth.ok) {
      try {
        emit('code', 'running', 'Product still thin — one enrichment pass…');
        const existing = await listFiles(dest).catch(() => []);
        const r = await ai.completeJson({
          task: 'CODING',
          system: SYSTEM,
          prompt: `${languageInstruction(project.idea || '', langOpts)}

ENRICHMENT PASS — checklist failed: ${depth.summary}
Issues: ${(depth.issues || []).join(', ')}
Files: ${existing.slice(0, 40).join(', ')}
Plan: ${JSON.stringify({ screens: plan?.screens, user_stories: plan?.user_stories, acceptance_checks: plan?.acceptance_checks }, null, 0)}

${fewShotBlock()}

Return JSON {"files":[...]} with concrete UI/API so a user can finish the main task. No name-only shell.`,
          projectId: project.id,
          validateJson: validateFiles,
        });
        const checked = await validateAndRepairPhaseFiles({ ai, project, files: r.json.files, label: 'Enrichment pass' });
        const paths = await writeGeneratedFiles(dest, checked);
        written = [...new Set([...written, ...paths])];
        phases.push({ phase: 'enrich', files: paths, notes: r.json.notes || '' });
      } catch (enrichErr) {
        phases.push({ phase: 'enrich', skipped: true, warning: String(enrichErr?.message || enrichErr).slice(0, 240) });
      }
    }

    return { files: written, phases, fallback: false };
  } catch (err) {
    lastError = err;
    // Fallback: single-shot full codePrompt if Phase 1 or Phase 2 failed
    if (singleShotPrompt) {
      try {
        emit('code', 'running', 'Multi-phase interrupted — trying one full generation…');
        const r = await ai.completeJson({
          task: 'CODING',
          system: SYSTEM,
          prompt: singleShotPrompt,
          projectId: project.id,
          validateJson: validateFiles,
        });
        const checked = await validateAndRepairPhaseFiles({ ai, project, files: r.json.files, label: 'Single-shot fallback' });
        written = await writeGeneratedFiles(dest, checked);
        phases.push({ phase: 'single_shot_fallback', files: written });
        return { files: written, phases, fallback: false, recovered: true };
      } catch (err2) {
        lastError = err2;
      }
    }
    if (!allowFallback) throw lastError;
    return { files: written, phases, fallback: true, error: lastError };
  }
}
