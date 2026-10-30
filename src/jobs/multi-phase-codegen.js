/**
 * Multi-phase code generation (Builder 1.8.14 / roadmap 1.10).
 * Phase 1 skeleton → Phase 2 product UI/API → Phase 3 polish/acceptance.
 */
import { SYSTEM, codePrompt } from '../ai/prompts.js';
import { fewShotBlock } from '../ai/few-shot-examples.js';
import { languageInstruction } from '../ai/language.js';
import { writeGeneratedFiles } from '../projects/generator.js';
import { listFiles } from '../utils/fsx.js';
import { evaluateProductDepth } from './product-checklist.js';

const validateFiles = (v) => Array.isArray(v?.files) && v.files.some((f) => f && typeof f.path === 'string' && typeof f.content === 'string');

function phasePrompt(project, plan, phase, existingFiles = []) {
  const lang = languageInstruction(project.idea || project.name || '');
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
- UI for the plan screens (home + main task minimum)
- API routes needed by the stories
- Wire frontend to backend (fetch forms/buttons)
- Persist simply (data/ JSON or sqlite) when the idea needs memory
You may overwrite skeleton files. No title-only pages.
`;
  }

  return `${lang}

PHASE 3/3 — POLISH + ACCEPTANCE
Project: ${project.name}
Acceptance checks: ${checks}
Present files: ${existing}

Return JSON {"files":[{"path":"...","content":"..."}],"notes":"..."}
Add/adjust only what is missing:
- Empty and error states in UI
- README.md short "how to use"
- tests that hit /health (and one product path if easy)
- docker-compose.yml + config_options.yml SoloHost-safe if missing
Do not remove working product behavior from phase 2.
`;
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
}) {
  const phases = [];
  let written = [];
  let lastError = null;

  const runPhase = async (n, label) => {
    emit('code', 'running', label);
    const existing = await listFiles(dest).catch(() => []);
    const prompt = phasePrompt(project, plan, n, existing);
    const r = await ai.completeJson({
      task: 'CODING',
      system: SYSTEM,
      prompt,
      projectId: project.id,
      validateJson: validateFiles,
    });
    const paths = await writeGeneratedFiles(dest, r.json.files);
    written = [...new Set([...written, ...paths])];
    phases.push({ phase: n, files: paths, notes: r.json.notes || '', provider: r.provider || null });
    return paths;
  };

  try {
    await runPhase(1, 'Phase 1/3 — foundation (server, health, Docker)…');
    await runPhase(2, 'Phase 2/3 — product UI and API…');
    await runPhase(3, 'Phase 3/3 — polish and acceptance…');

    // If still thin, one targeted enrichment shot (not a full restart)
    const depth = await evaluateProductDepth(dest, { name: project.name, idea: project.idea });
    if (!depth.ok) {
      emit('code', 'running', 'Product still thin — one enrichment pass…');
      const existing = await listFiles(dest).catch(() => []);
      const r = await ai.completeJson({
        task: 'CODING',
        system: SYSTEM,
        prompt: `${languageInstruction(project.idea || '')}

ENRICHMENT PASS — checklist failed: ${depth.summary}
Issues: ${(depth.issues || []).join(', ')}
Files: ${existing.slice(0, 40).join(', ')}
Plan: ${JSON.stringify({ screens: plan?.screens, user_stories: plan?.user_stories, acceptance_checks: plan?.acceptance_checks }, null, 0)}

${fewShotBlock()}

Return JSON {"files":[...]} with concrete UI/API so a user can finish the main task. No name-only shell.`,
        projectId: project.id,
        validateJson: validateFiles,
      });
      const paths = await writeGeneratedFiles(dest, r.json.files);
      written = [...new Set([...written, ...paths])];
      phases.push({ phase: 'enrich', files: paths, notes: r.json.notes || '' });
    }

    return { files: written, phases, fallback: false };
  } catch (err) {
    lastError = err;
    // Fallback: single-shot full codePrompt if multi-phase failed early
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
        written = await writeGeneratedFiles(dest, r.json.files);
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
