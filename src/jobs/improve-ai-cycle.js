import { listFiles } from '../utils/fsx.js';
/**
 * Improve AI cycle (Releases C-2, D1, D4 groundwork).
 *
 * One call to requestImprovePatch() performs a bounded conversation with the AI:
 *   1. ask for a change (edits / files / new_files) — or for more code (NEED_FILES, max 2 rounds);
 *   2. convert anchored edits into whole files (exact-once rule);
 *   3. validate paths (look-alikes / traversal) and syntax BEFORE anything is written;
 *   4. when 2 or 3 fail, send the precise problem back to the AI and ask for a corrected change
 *      (max 2 correction rounds, each prompt is different — no identical retries).
 * It never writes files. The pipeline applies the result, verifies it and may call this again
 * with `problemNote` if verification fails (verify → feedback → retry).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseNeedFiles } from '../ai/response-doctor.js';
import { filterPatchFiles, remapAndFilterPatchFiles } from './path-safety.js';
import { applyEdits, describeEditErrors } from './edits.js';
import { syntaxCheckFiles, describeSyntaxErrors } from './syntax-check.js';
import { mapPatchResult, formatOutcomeMessage, outcomeBrief, localeOf, OUTCOMES } from './outcomes.js';

const asArray = (v) => (Array.isArray(v) ? v : []);

function collectNeedPaths(r, json = {}) {
  const fromMeta = asArray(r?.needFiles).map(String);
  const fromJson = [
    ...asArray(json?.need_files),
    ...asArray(json?.needFiles),
    ...asArray(json?.files_needed),
    ...asArray(json?.filesNeeded),
  ].map(String);
  const fromText = parseNeedFiles(r?.text || '');
  const out = [];
  for (const x of [...fromMeta, ...fromJson, ...fromText]) {
    const t = String(x || '').trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** Inventory + task only — strip heavy --- path --- bodies for the file-pick phase. */
export function inventoryOnlyContext(contextText = '') {
  const s = String(contextText || '');
  const lines = s.split('\n');
  const out = [];
  let skippingBody = false;
  for (const line of lines) {
    if (/^---\s+\S+/.test(line) && !/FILE INVENTORY|LIVE FILE|AUTHORITATIVE|CONTEXT POLICY|ADDITIONAL FILES/i.test(line)) {
      skippingBody = true;
      continue;
    }
    if (skippingBody) {
      if (/^---\s+/.test(line) || /^AUTHORITATIVE|^CONTEXT POLICY|^--- FILE INVENTORY|^--- LIVE FILE|^ADDITIONAL FILES/i.test(line)) {
        skippingBody = false;
        if (/^---\s+\S+/.test(line) && !/FILE INVENTORY|LIVE FILE|ADDITIONAL FILES/i.test(line)) {
          skippingBody = true;
          continue;
        }
      } else {
        continue;
      }
    }
    out.push(line);
  }
  const text = out.join('\n').trim();
  return text || s.slice(0, 8000);
}

function filePickPrompt({ project, feedback, inventoryText, language }) {
  const loc = localeOf(language);
  const task = String(feedback || '').slice(0, 4000);
  return `${loc === 'vi' ? 'Ngôn ngữ: chỉ JSON.' : 'Language: JSON only.'}

PROTOCOL STEP 1/2 — SELECT FILES (do not edit yet)

User task:
${task}

Project: ${project?.name || project?.slug || 'app'}

${inventoryText}

Return ONLY JSON:
{"need_files":["path/from/inventory.js","other.js"],"reason":"short why these files"}

Rules:
- Paths must appear in FILE INVENTORY / LIVE FILE INVENTORY.
- Pick the minimum files required for the task (1–8).
- Do NOT return files/edits/new_files content in this step.
- If only a brand-new file is needed, return need_files:[] and say so in reason.`;
}

function workPromptPreamble(providedPaths) {
  return `
PROTOCOL STEP 2/2 — PERFORM THE TASK
You have been given the contents of: ${(providedPaths || []).join(', ') || '(none)'}.
Use ONLY these bodies plus the inventory. If still missing a path, return need_files again (no edits).
Otherwise return the patch (files / edits / new_files).
`;
}



export async function loadNeedFileSnippets(sourceDir, specs, { maxFiles = 8, maxChars = 24000, perFile = 12000 } = {}) {
  const out = [];
  let used = 0;
  for (const spec of (specs || []).slice(0, maxFiles)) {
    const raw = String(spec);
    const m = /^(.*?)(?::(\d+)-(\d+))?$/.exec(raw.trim());
    const rel = (m?.[1] || raw).replace(/\\/g, '/').replace(/^\.?\/+/, '');
    if (!rel || rel.includes('..')) continue;
    let text = '';
    try {
      text = await fs.readFile(path.join(sourceDir, rel), 'utf8');
    } catch {
      out.push({ path: rel, error: 'not found' });
      continue;
    }
    let body = text;
    let note = '';
    if (m?.[2]) {
      const a = Math.max(1, Number(m[2]));
      const b = Math.max(a, Number(m[3]));
      body = text.split('\n').slice(a - 1, b).join('\n');
      note = ` (lines ${a}-${b} of ${text.split('\n').length})`;
    }
    if (body.length > perFile) { body = body.slice(0, perFile); note += ' (cut at limit - ask again with a narrower line range for the rest)'; }
    if (used + body.length > maxChars) break;
    used += body.length;
    out.push({ path: rel, content: body, note });
  }
  return out;
}

function validPatchShape(v) {
  return Boolean(v && typeof v === 'object' && !Array.isArray(v)
    && (Array.isArray(v.files) || Array.isArray(v.edits) || Array.isArray(v.new_files) || Array.isArray(v.need_files) || Array.isArray(v.needFiles)));
}

/** Turn an AI answer into whole files: apply edits, add new_files, keep explicit files. */
async function materialize({ sourceDir, json }) {
  const problems = [];
  const byPath = new Map();
  for (const f of asArray(json.files)) if (f && f.path && typeof f.content === 'string') byPath.set(String(f.path).replace(/\\/g, '/'), { path: String(f.path).replace(/\\/g, '/'), content: f.content });
  let declaredNew = [];
  for (const f of asArray(json.new_files)) {
    if (f && f.path && typeof f.content === 'string') {
      const rel = String(f.path).replace(/\\/g, '/').replace(/^\.?\/+/, '');
      byPath.set(rel, { path: rel, content: f.content });
      declaredNew.push(rel);
    }
  }
  if (asArray(json.edits).length) {
    const applied = await applyEdits({ sourceDir, edits: json.edits });
    if (!applied.ok) problems.push({ kind: 'edits', text: `Some edits could not be applied (nothing was changed):\n${describeEditErrors(applied.errors)}` });
    else for (const f of applied.files) byPath.set(f.path, f);
  }
  return { files: [...byPath.values()], declaredNew, problems };
}

/**
 * @returns {Promise<{ ok: boolean, outcome: string, message: string, json: object, files: object[], created: string[],
 *   rejected: string[], rounds: number, brief?: object, error?: Error }>}
 */
export async function requestImprovePatch({
  ai,
  SYSTEM,
  patchPrompt,
  project,
  feedback,
  contextText,
  sourceDir,
  images = [],
  emit = () => {},
  language = 'English',
  maxNeedRounds = 3,
  maxFixRounds = Number(process.env.IMPROVE_MAX_FIX_ROUNDS ?? 2),
  problemNote = '',
  task = 'DEBUGGING',
} = {}) {
  const loc = localeOf(language);
  let extra = contextText || '';
  let note = problemNote ? `\nPREVIOUS ATTEMPT PROBLEM (fix exactly this, do not repeat the same change):\n${String(problemNote).slice(0, 4000)}\n` : '';
  let needRounds = 0;
  let fixRounds = 0;
  let rounds = 0;
  let last = null;

  // --- PROTOCOL: inventory (names) → AI picks files → Builder loads bodies → AI patches ----------
  let providedPaths = [];
  if (sourceDir && !/LIVE FILE INVENTORY/.test(extra)) {
    try {
      const live = await listFiles(sourceDir).catch(() => []);
      const inv = live.map((f) => String(f).replace(/\\/g, '/')).filter((f) => !/(^|\/)(node_modules|\.git)(\/|$)/.test(f));
      extra += `\n\n--- LIVE FILE INVENTORY (${inv.length} paths, names only) ---\n`
        + 'STEP 1: return need_files for paths you must read. STEP 2 (after Builder provides them): return the patch.\n'
        + inv.slice(0, 220).join('\n') + '\n';
    } catch { /* ignore */ }
  }

  // Step 1 — force file selection first (task + inventory only), unless caller already attached bodies.
  const alreadyHasBodies = /ADDITIONAL FILES \(requested/.test(extra) || /--- [a-zA-Z0-9_./-]+ ---\n[\s\S]{80,}/.test(contextText || '');
  if (sourceDir && !alreadyHasBodies && !problemNote) {
    emit('context', 'running', loc === 'vi'
      ? 'Bước 1/2: AI chọn tệp cần đọc…'
      : 'Step 1/2: AI selecting files to read…');
    try {
      const invCtx = inventoryOnlyContext(extra);
      const pick = await ai.completeJson({
        task: 'DEBUGGING',
        system: SYSTEM,
        prompt: filePickPrompt({ project, feedback, inventoryText: invCtx, language }),
        projectId: project.id,
        validateJson: (v) => v && (Array.isArray(v.need_files) || Array.isArray(v.needFiles) || Array.isArray(v.files_needed)),
        allowNeedFiles: true,
      });
      last = pick;
      const pickJson = pick.json && typeof pick.json === 'object' ? pick.json : {};
      let needs = collectNeedPaths(pick, pickJson);
      if (!needs.length && Array.isArray(pickJson.need_files)) needs = pickJson.need_files.map(String);
      if (needs.length) {
        needRounds += 1;
        emit('context', 'running', loc === 'vi'
          ? `Đang cung cấp tệp AI yêu cầu: ${needs.slice(0, 6).join(', ')}`
          : `Providing files AI requested: ${needs.slice(0, 6).join(', ')}`);
        const snippets = await loadNeedFileSnippets(sourceDir, needs);
        providedPaths = snippets.filter((s) => s.content).map((s) => s.path);
        extra += `\n\nADDITIONAL FILES (requested by you — use these for the task):\n${snippets.map((s) => (s.error ? `--- ${s.path}: ${s.error}` : `--- ${s.path}${s.note || ''} ---\n${s.content}`)).join('\n\n')}\n`;
        note += workPromptPreamble(providedPaths);
      } else {
        note += '\nNo need_files returned in step 1. Proceed only if the inventory + task is enough; otherwise return need_files.\n';
      }
    } catch (err) {
      // Non-fatal: fall through to normal loop (AI may still emit need_files).
      note += `\nFile-pick step skipped (${String(err.message || err).slice(0, 120)}). You may return need_files first.\n`;
    }
  }

  for (;;) {
    rounds += 1;
    if (rounds === 1) {
      emit('repair', 'running', loc === 'vi'
        ? 'Bước 2/2: AI thực hiện nhiệm vụ trên các tệp đã cung cấp…'
        : 'Step 2/2: AI performing the task on provided files…');
    }
    const r = await ai.completeJson({
      task,
      system: SYSTEM,
      prompt: patchPrompt(project, '', extra + note, feedback),
      projectId: project.id,
      images,
      validateJson: validPatchShape,
      allowNeedFiles: true,
    });
    last = r;
    const json = r.json && typeof r.json === 'object' ? r.json : {};

    // Prefer NEED_FILES over any concurrent patch — protocol: files first, then change.
    const needs = collectNeedPaths(r, json);
    const hasChange = asArray(json.files).length || asArray(json.edits).length || asArray(json.new_files).length;
    if (needs.length) {
      if (needRounds >= maxNeedRounds) {
        note += '\nYou already received requested files. Answer NOW with a change (or files:[] if impossible).\n';
        if (hasChange) {
          /* fall through to apply change */
        } else {
          needRounds += 1;
          if (needRounds > maxNeedRounds + 1) break;
          continue;
        }
      } else {
        needRounds += 1;
        emit('context', 'running', loc === 'vi'
          ? `Đang cung cấp thêm tệp: ${needs.slice(0, 6).join(', ')}`
          : `Providing more files: ${needs.slice(0, 6).join(', ')}`);
        const snippets = await loadNeedFileSnippets(sourceDir, needs);
        for (const s of snippets) if (s.content && !providedPaths.includes(s.path)) providedPaths.push(s.path);
        extra += `\n\nADDITIONAL FILES (requested by you):\n${snippets.map((s) => (s.error ? `--- ${s.path}: ${s.error}` : `--- ${s.path}${s.note || ''} ---\n${s.content}`)).join('\n\n')}\n`;
        note = workPromptPreamble(providedPaths) + (hasChange ? '\nIgnore your previous patch until you have used the new files.\n' : '');
        continue; // do not apply patch in the same turn as a new need_files request
      }
    }

    // Uncertain AI payload: salvage once
    if (!hasChange && r.text && /files|path|content|```/.test(String(r.text)) && fixRounds < maxFixRounds) {
      try {
        emit('repair', 'running', loc === 'vi' ? 'Đang nhờ AI đọc lại kết quả chưa rõ…' : 'Asking AI to re-read an unclear result…');
        const salvage = await ai.completeJson({
          task: 'DEBUGGING',
          system: SYSTEM,
          prompt: `Convert the following model output into ONE JSON object with optional keys files, new_files, edits, need_files, explanation, risk.
Use only real relative paths. files[].path + files[].content for full files.
RAW:\n${String(r.text).slice(0, 12000)}`,
          projectId: project.id,
          validateJson: validPatchShape,
        });
        if (salvage?.json && (asArray(salvage.json.files).length || asArray(salvage.json.edits).length || asArray(salvage.json.new_files).length)) {
          fixRounds += 1;
          last = salvage;
          note = '';
          // Restart loop body with salvaged json by stitching into next iteration
          Object.assign(json, salvage.json);
          // fall through: update hasChange via continue after replacing last response
          extra += '\n(Salvaged a non-JSON model answer into structured files.)\n';
          // Process salvaged result immediately by simulating hasChange
          const sj = salvage.json;
          const mat0 = await materialize({ sourceDir, json: sj });
          if (mat0.files.length) {
            const gate0 = await remapAndFilterPatchFiles({ sourceDir, files: mat0.files, allowedNew: mat0.declaredNew || [], allowImplicitNew: true, maxNew: 8 });
            if (gate0.files.length) {
              return { ok: true, outcome: OUTCOMES.DONE, json: { ...sj, files: gate0.files, risk: String(sj.risk || 'low').toLowerCase() }, files: gate0.files, created: gate0.created || [], rejected: gate0.rejected || [], rounds, risk: String(sj.risk || 'low').toLowerCase() };
            }
          }
        }
      } catch { /* keep original */ }
    }

    // --- nothing to change ---------------------------------------------------------------------------
    if (!hasChange) {
      const mapped = mapPatchResult({ filesChanged: 0 });
      const brief = outcomeBrief(mapped, language, { detail: json.explanation ? String(json.explanation).slice(0, 400) : '' });
      return { ok: false, outcome: mapped.outcome, message: brief.message, brief, json, files: [], created: [], rejected: [], rounds };
    }

    // --- D1: materialize edits / new files, then gate paths + syntax ---------------------------------
    const mat = await materialize({ sourceDir, json });
    let problems = [...mat.problems];
    let files = mat.files;
    let created = [];
    let rejected = [];
    if (!problems.length && files.length) {
      const safe = await remapAndFilterPatchFiles({ sourceDir, files, allowedNew: mat.declaredNew || [], allowImplicitNew: true, maxNew: 8 });
      rejected = safe.rejected;
      created = safe.created;
      if (safe.rejected.length || !safe.files.length) problems.push({ kind: 'paths', text: safe.suggestion || 'No usable file paths in your answer.' });
      else {
        // drop files whose content is byte-identical to what is already there (a "change" that changes nothing)
        const real = [];
        for (const f of safe.files) {
          const cur = await fs.readFile(path.join(sourceDir, f.path), 'utf8').catch(() => null);
          if (cur === null || cur !== f.content) real.push(f);
        }
        if (!real.length) {
          const mapped = mapPatchResult({ filesChanged: 0 });
          const brief = outcomeBrief(mapped, language, { detail: loc === 'vi' ? 'AI trả về nội dung giống hệt tệp hiện có.' : 'The AI returned content identical to the current files.' });
          return { ok: false, outcome: mapped.outcome, message: brief.message, brief, json, files: [], created: [], rejected: [], rounds };
        }
        files = real;
        const syn = await syntaxCheckFiles(files);
        if (!syn.ok) problems.push({ kind: 'syntax', text: `Syntax errors in your proposed files (nothing was written):\n${describeSyntaxErrors(syn.errors)}` });
      }
    }
    if (problems.length && fixRounds < maxFixRounds) {
      fixRounds += 1;
      emit('repair', 'running', loc === 'vi' ? `Đang yêu cầu AI sửa lại đề xuất (${fixRounds}/${maxFixRounds})…` : `Asking the AI to correct its proposal (${fixRounds}/${maxFixRounds})…`);
      note = `\nPROBLEM WITH YOUR PREVIOUS ANSWER (correct it; do not repeat it):\n${problems.map((p) => p.text).join('\n')}\n`;
      continue;
    }
    if (problems.length) {
      const detail = problems.map((p) => p.text).join('\n').slice(0, 800);
      const kinds = new Set(problems.map((p) => p.kind));
      const mapped = {
        outcome: OUTCOMES.NEEDS_ACTION,
        reasonEn: kinds.has('syntax') ? 'The AI proposed code with syntax errors, so nothing was changed.'
          : kinds.has('paths') ? 'The AI named files that do not exist in this project, so nothing was changed.'
            : 'The AI\'s edits did not match the current files, so nothing was changed.',
        reasonVi: kinds.has('syntax') ? 'AI đề xuất mã bị lỗi cú pháp nên chưa thay đổi gì.'
          : kinds.has('paths') ? 'AI nêu tên tệp không tồn tại trong dự án nên chưa thay đổi gì.'
            : 'Các chỉnh sửa AI đề xuất không khớp với tệp hiện tại nên chưa thay đổi gì.',
        nextEn: 'Try again, or describe the change in smaller steps.',
        nextVi: 'Thử lại, hoặc mô tả thay đổi theo từng bước nhỏ hơn.',
      };
      const brief = outcomeBrief(mapped, language, { detail });
      return { ok: false, outcome: OUTCOMES.NEEDS_ACTION, message: brief.message, brief, json, files: [], created: [], rejected, rounds, problems };
    }
    const risk = String(json.risk || 'low').toLowerCase();
    return { ok: true, outcome: OUTCOMES.DONE, json: { ...json, files, risk }, files, created, rejected, rounds, risk };
  }

  const mapped = mapPatchResult({ filesChanged: 0 });
  const brief = outcomeBrief(mapped, language);
  return { ok: false, outcome: mapped.outcome, message: brief.message, brief, json: last?.json || {}, files: [], created: [], rejected: [], rounds };
}

export { mapPatchResult, formatOutcomeMessage, OUTCOMES };
