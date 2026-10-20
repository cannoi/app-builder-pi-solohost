/**
 * Change Engine V2 entry for MODIFY intent.
 * Does not call applySafeAiPatch / patchPrompt.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { applyEditsInMemory, isUnsafePath, normalizeLf, MAX_FILES } from './edits.js';
import { modifyEditsPrompt } from './prompts.js';
import { runAgentLoop, createReadOnlyTools } from './agent-loop.js';
import { buildChecklist, evaluateChecklist, checklistNeedsRepair, formatChecklistReport } from './checklist.js';
import { isChangeEngineV2Enabled } from './flags.js';

export { isChangeEngineV2Enabled };

async function walkFiles(dir, base = dir, out = []) {
  let entries = [];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const abs = path.join(dir, e.name);
    const rel = path.relative(base, abs).replace(/\\/g, '/');
    if (e.isDirectory()) await walkFiles(abs, base, out);
    else out.push(rel);
  }
  return out;
}

export async function runModifyEngine({
  sourceDir,
  project,
  feedback,
  ai,
  emit = () => {},
  language = 'en',
  context = '',
  useAgentLoop = true,
  runStaticTests,
  runNodeTests,
  scanProject,
  maxEditRetries = 2,
} = {}) {
  const listFiles = async () => walkFiles(sourceDir);
  const readFileAbs = async (abs) => fs.readFile(abs, 'utf8');
  const readRel = async (rel) => fs.readFile(path.join(sourceDir, rel), 'utf8');

  let edits = [];
  let explanation = '';
  let risk = 'medium';
  let steps = [];

  if (useAgentLoop) {
    const tools = createReadOnlyTools({
      sourceDir,
      listFiles,
      readFile: readFileAbs,
      runStatic: runStaticTests,
      runNode: runNodeTests,
      runScan: scanProject,
    });
    const loop = await runAgentLoop({
      ai,
      prompt: modifyEditsPrompt({ project, feedback, context, language }),
      tools,
      emit,
    });
    if (!loop.ok && !(loop.edits || []).length) {
      return { ok: false, error: loop.error || 'agent loop produced no edits', steps: loop.steps };
    }
    edits = loop.edits || [];
    explanation = loop.explanation || '';
    risk = loop.risk || 'medium';
    steps = loop.steps || [];
  } else {
    const r = await ai.completeJson({
      task: 'CHANGE_ENGINE',
      system: 'Return JSON edits only.',
      prompt: modifyEditsPrompt({ project, feedback, context, language }),
    });
    edits = Array.isArray(r?.json?.edits) ? r.json.edits : [];
    explanation = String(r?.json?.explanation || '');
    risk = String(r?.json?.risk || 'medium').toLowerCase();
  }

  if (!edits.length) {
    return { ok: true, noChange: true, explanation: explanation || 'No edits proposed', risk, steps, files: [] };
  }

  // Load only touched + common files
  const paths = [...new Set(edits.map((e) => String(e.path || '').replace(/\\/g, '/')))].filter(Boolean);
  if (paths.length > MAX_FILES) {
    return { ok: false, error: `too many files in edits (${paths.length})` };
  }
  const fileMap = {};
  for (const rel of paths) {
    if (isUnsafePath(rel)) return { ok: false, error: `unsafe path: ${rel}` };
    try { fileMap[rel] = await readRel(rel); } catch { /* create */ }
  }

  let applied = applyEditsInMemory(fileMap, edits);
  let attempt = 0;
  while (!applied.ok && attempt < maxEditRetries) {
    attempt += 1;
    emit('repair', 'running', `Edit apply failed (${applied.error}); asking AI to fix search (${attempt}/${maxEditRetries})`);
    const fix = await ai.completeJson({
      task: 'CHANGE_ENGINE',
      system: 'Fix the edits JSON so each search matches exactly once.',
      prompt: `Previous error: ${applied.error}\nNearest:\n${applied.nearest || ''}\nPrior edits:\n${JSON.stringify(edits).slice(0, 12000)}\nReturn corrected {"edits":[...],"explanation":"...","risk":"..."}`,
    });
    edits = Array.isArray(fix?.json?.edits) ? fix.json.edits : edits;
    explanation = String(fix?.json?.explanation || explanation);
    risk = String(fix?.json?.risk || risk).toLowerCase();
    const paths2 = [...new Set(edits.map((e) => String(e.path || '')))];
    for (const rel of paths2) {
      if (isUnsafePath(rel)) continue;
      if (!(rel in fileMap)) {
        try { fileMap[rel] = await readRel(rel); } catch { /* */ }
      }
    }
    applied = applyEditsInMemory(fileMap, edits);
  }
  if (!applied.ok) {
    return { ok: false, error: applied.error, nearest: applied.nearest, steps };
  }

  // Commit to disk
  for (const rel of applied.touched) {
    const abs = path.join(sourceDir, rel);
    if (!(rel in applied.files)) {
      await fs.unlink(abs).catch(() => {});
    } else {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, normalizeLf(applied.files[rel]), 'utf8');
    }
  }

  const checklist = buildChecklist(feedback);
  return {
    ok: true,
    noChange: false,
    explanation,
    risk,
    steps,
    files: applied.touched,
    edits,
    checklist,
    fileContents: applied.files,
  };
}

export async function verifyModifyResult({
  sourceDir,
  baseline,
  runStaticTests,
  runNodeTests,
  scanProject,
  checklist,
  fileContents,
  emit = () => {},
}) {
  const afterStatic = await runStaticTests(sourceDir);
  const afterNode = await runNodeTests(sourceDir, 45000);
  const afterScan = await scanProject(sourceDir);
  const checks = { static: afterStatic, node: afterNode, scan: afterScan };
  const checklistResults = await evaluateChecklist(checklist || [], { fileContents, checks });
  const score = (s, n) => (s?.status === 'failed' ? 2 : 0) + (n?.status === 'failed' ? 2 : 0);
  const before = score(baseline?.staticResult, baseline?.nodeResult);
  const after = score(afterStatic, afterNode);
  const criticalUp = (afterScan.critical || 0) > (baseline?.scan?.critical || 0);
  const regressed = after > before || (afterScan.critical || 0) > 0 && criticalUp;
  const requiredFail = checklistNeedsRepair(checklistResults);

  if (regressed || requiredFail) {
    return {
      ok: false,
      regressed: true,
      requiredFail,
      tested: { staticResult: afterStatic, nodeResult: afterNode, scan: afterScan },
      checklistResults,
      report: formatChecklistReport(checklistResults),
    };
  }
  emit('verify', 'done', formatChecklistReport(checklistResults));
  return {
    ok: true,
    tested: { staticResult: afterStatic, nodeResult: afterNode, scan: afterScan },
    checklistResults,
    report: formatChecklistReport(checklistResults),
  };
}

export default { runModifyEngine, verifyModifyResult, isChangeEngineV2Enabled };
