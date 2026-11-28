import fs from 'node:fs/promises';
import path from 'node:path';
import { evaluateProductDepth } from '../jobs/product-checklist.js';
import { buildCustomizePrompt } from './first-run-quality.js';

const MAX_ROUNDS = 4;

async function fileExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

export async function assessProjectCompleteness(sourceDir) {
  const checks = {
    hasPackageJson: await fileExists(path.join(sourceDir, 'package.json')),
    hasDockerfile: await fileExists(path.join(sourceDir, 'Dockerfile')),
    hasCompose: await fileExists(path.join(sourceDir, 'docker-compose.yml')),
    hasConfigOptions: await fileExists(path.join(sourceDir, 'config_options.yml')),
    hasServer: await fileExists(path.join(sourceDir, 'src', 'server.js'))
      || await fileExists(path.join(sourceDir, 'server.js')),
    hasPublic: await fileExists(path.join(sourceDir, 'public', 'index.html'))
      || await fileExists(path.join(sourceDir, 'index.html')),
  };
  let healthOk = false;
  for (const rel of ['src/server.js', 'server.js']) {
    const p = path.join(sourceDir, rel);
    if (!(await fileExists(p))) continue;
    try {
      const txt = await fs.readFile(p, 'utf8');
      if (/\/health/.test(txt)) healthOk = true;
    } catch { /* ignore */ }
  }
  checks.hasHealth = healthOk;
  const depth = await evaluateProductDepth(sourceDir, {});
  const missing = ['hasDockerfile', 'hasCompose', 'hasConfigOptions'].filter((k) => !checks[k]);
  return {
    checks,
    missing,
    fileCount: depth.metrics?.files ?? 0,
    score: depth.score,
    depth,
    usable: missing.length === 0 && depth.ok,
  };
}

export async function runInitQualityLoop({
  project, projects, idea, templateId, emit, improveProject, testAndMaybeFix, hasAi = false,
} = {}) {
  const sourceDir = projects.sourceDir(project.slug);
  const rounds = [];
  let assessment = await assessProjectCompleteness(sourceDir);
  rounds.push({ round: 0, phase: 'baseline', score: assessment.score, usable: assessment.usable, issues: assessment.depth?.issues });

  if (!hasAi) {
    try { await testAndMaybeFix?.(projects.get(project.id), emit); } catch { /* optional */ }
    assessment = await assessProjectCompleteness(sourceDir);
    rounds.push({ round: 0, phase: 'no-ai-test', score: assessment.score, usable: assessment.usable });
    return {
      ok: assessment.usable,
      assessment,
      rounds,
      roundsRun: 0,
      mode: 'template-baseline-only',
      blockedReason: assessment.usable ? null : 'AI is not configured and the template did not meet the product quality gate.',
    };
  }

  for (let i = 1; i <= MAX_ROUNDS; i += 1) {
    if (assessment.usable && i > 1) break;
    const prompt = buildCustomizePrompt({ idea, templateId, phase: i, assessment });
    emit?.('init_loop', 'running', `Quality phase ${i}/${MAX_ROUNDS} (professional UI + domain features)…`);
    try {
      await improveProject(projects.get(project.id), prompt, emit);
    } catch (err) {
      rounds.push({ round: i, phase: 'improve_error', error: String(err.message || err).slice(0, 300) });
    }
    try {
      const tested = await testAndMaybeFix?.(projects.get(project.id), emit);
      rounds.push({ round: i, phase: 'test', tested: tested?.status || 'done' });
    } catch (err) {
      rounds.push({ round: i, phase: 'test_error', error: String(err.message || err).slice(0, 200) });
    }
    assessment = await assessProjectCompleteness(sourceDir);
    rounds.push({ round: i, phase: 'assess', score: assessment.score, usable: assessment.usable, issues: assessment.depth?.issues });
    if (assessment.usable) break;
  }
  return {
    ok: assessment.usable,
    assessment,
    rounds,
    roundsRun: rounds.filter((r) => r.phase === 'assess').length,
    mode: 'ai-quality-loop',
  };
}

export default { assessProjectCompleteness, runInitQualityLoop };
