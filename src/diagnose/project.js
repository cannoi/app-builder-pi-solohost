import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { listFiles } from '../utils/fsx.js';
import { fingerprintError } from '../dare/fingerprint.js';

const IMPORTANT = /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Dockerfile|docker-compose\.ya?ml|compose\.ya?ml|vite\.config\..*|next\.config\..*|server\..*|index\..*|app\..*|routes?\..*|README.*|\.env\.example)$/i;
const SOURCE = /\.(js|mjs|cjs|ts|tsx|jsx|html|css|py|json|ya?ml)$/i;

export async function diagnoseProject({ project, projects, db = null, ai = null, logs = '' } = {}) {
  const sourceDir = projects.sourceDir(project.slug);
  const manifest = await manifestOf(sourceDir);
  const files = manifest.map((x) => x.path);
  const important = files.filter((f) => IMPORTANT.test(f)).slice(0, 60);
  const reads = await readImportant(sourceDir, important);
  const stack = detectStack(files, reads);
  const runtime = detectRuntime(reads);
  const logText = String(logs || '');
  const fingerprint = fingerprintError(logText) || 'NONE';
  const evidence = [];
  if (fingerprint !== 'NONE' && fingerprint !== 'UNKNOWN') evidence.push({ type: 'runtime-log', finding: fingerprint, detail: logText.slice(-2500) });
  if (runtime.writePaths.length) evidence.push({ type: 'filesystem', finding: 'runtime-write-paths', detail: runtime.writePaths.slice(0, 20) });
  if (runtime.localhostBinds.length) evidence.push({ type: 'network', finding: 'container-localhost-bind', detail: runtime.localhostBinds });
  if (runtime.portHints.length) evidence.push({ type: 'port', finding: 'port-hints', detail: runtime.portHints });
  if (stack.entryPoints.length) evidence.push({ type: 'entrypoint', finding: 'entry-points', detail: stack.entryPoints });
  const history = await projects.readMetadata(project, 'upgrade-repair-history.json', []);
  const diagnosisHistory = await projects.readMetadata(project, 'diagnosis-history.json', []);
  const recentJobs = db ? db.all('SELECT id,type,status,stage,error,created_at,updated_at FROM jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT 20', project.id) : [];
  const recentEvents = db ? db.all('SELECT job_id,stage,status,message,created_at FROM job_events WHERE job_id IN (SELECT id FROM jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT 10) ORDER BY id DESC LIMIT 80', project.id) : [];
  const prior = [...(Array.isArray(history) ? history : []), ...(Array.isArray(diagnosisHistory) ? diagnosisHistory : []), ...recentJobs.map((j) => ({ fingerprint: fingerprintError(j.error || ''), error: j.error, type: j.type, status: j.status }))].slice(-60);
  const repeated = detectRepeatedFailures(prior, fingerprint);
  let rootCause = 'No deterministic root cause is proven yet.';
  let confidence = 'low';
  const problems = [];
  if (fingerprint.startsWith('RUNTIME_FILESYSTEM_PERMISSION')) {
    rootCause = `The runtime process cannot write ${fingerprint.split(':').slice(1).join(':') || 'the required application data path'}.`;
    confidence = 'high';
    problems.push({ id: 'RUNTIME_FILESYSTEM_PERMISSION', severity: 'high', evidence: fingerprint, recommendation: 'Inspect the runtime user and make only the application-owned runtime path writable.' });
  } else if (runtime.localhostBinds.length) {
    rootCause = 'The HTTP server appears to bind only to localhost inside the container.';
    confidence = 'high';
    problems.push({ id: 'CONTAINER_LOCALHOST_BIND', severity: 'high', evidence: runtime.localhostBinds, recommendation: 'Bind the exposed HTTP server to 0.0.0.0 only when this server is the container entry point.' });
  } else if (!stack.entryPoints.length && stack.hasPackage) {
    rootCause = 'No clear application entry point was identified from the project manifest.';
    confidence = 'medium';
    problems.push({ id: 'ENTRYPOINT_UNCLEAR', severity: 'medium', evidence: 'No server/index/app entry point detected', recommendation: 'Inspect package scripts and framework configuration before changing files.' });
  }
  if (repeated.length) {
    problems.push({ id: 'REPEATED_INEFFECTIVE_REPAIR', severity: 'high', evidence: repeated, recommendation: 'Stop repeating the previous repair and perform deeper diagnosis.' });
    if (confidence === 'low') confidence = 'medium';
  }
  const report = {
    incidentId: `DIAG-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`,
    projectId: project.id, currentStatus: project.status, stack, runtime, fingerprint,
    problems, rootCause, confidence, evidence: evidence.slice(0, 30), affectedFiles: important,
    previousFailedAttempts: repeated,
    recentActivity: { jobs: recentJobs.map((j) => ({ id: j.id, type: j.type, status: j.status, stage: j.stage, error: String(j.error || '').slice(0, 1200), createdAt: j.created_at, updatedAt: j.updated_at })), events: recentEvents.map((e) => ({ stage: e.stage, status: e.status, message: String(e.message || '').slice(0, 1200), createdAt: e.created_at })) },
    recommendation: problems[0]?.recommendation || 'Collect a runtime/build/preview failure signal before changing code.',
    verificationPlan: ['Inspect affected files', 'Apply the smallest evidence-backed change only if safe', 'Build', 'Start exact runtime', 'Health/HTTP check', 'Functional/preview check', 'Compare before/after'],
    generatedAt: new Date().toISOString(),
  };
  if (ai) {
    try {
      const prompt = `PROJECT DIAGNOSER. Diagnose only from evidence. Do not invent facts. Preserve the app and never propose a patch without a proven root cause.\nREPORT:\n${JSON.stringify(report)}\nFILES:\n${reads.slice(0, 80000)}\nReturn JSON with root_cause, confidence, problems, recommendation, files, verification, stop_repeating.`;
      const result = await ai.completeJson({ task: 'PROJECT_DIAGNOSIS', system: 'You are a deterministic-first project diagnostician.', prompt, projectId: project.id });
      report.ai = result.json || null;
    } catch (err) {
      report.ai = { unavailable: true, reason: String(err.message || err).slice(0, 500) };
    }
  }
  await projects.saveMetadata(project, 'project-diagnosis.json', report);
  await appendHistory(projects, project, report);
  if (db) db.setSetting(`diagnosis:${project.id}`, { incidentId: report.incidentId, fingerprint: report.fingerprint, generatedAt: report.generatedAt });
  return report;
}

export async function buildAdvisorReport({ project, projects, db = null } = {}) {
  const repairs = await projects.readMetadata(project, 'upgrade-repair-history.json', []);
  const history = await projects.readMetadata(project, 'upgrade-history.json', []);
  const diagnosis = await projects.readMetadata(project, 'project-diagnosis.json', null);
  const chat = await projects.readMetadata(project, 'chat.json', []);
  const userMessages = (Array.isArray(chat) ? chat : []).filter((m) => m?.role === 'user').map((m) => String(m.message || '').trim()).filter(Boolean);
  const repeatedRequests = countRepeated(userMessages.map((m) => m.toLowerCase()));
  const jobs = db ? db.all('SELECT type,status,error,created_at FROM jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT 50', project.id) : [];
  const failedJobs = jobs.filter((j) => j.status === 'failed');
  const repeated = countRepeated(failedJobs.map((j) => j.error || j.type));
  const findings = [];
  if (repeated.length) findings.push({ problem: 'Repeated failed actions', evidence: repeated, impact: 'Users can get stuck retrying the same operation.', recommendation: 'Show the previous failure and require new evidence before another repair.' });
  if ((repairs || []).length > 3) findings.push({ problem: 'Repeated repair history', evidence: `${repairs.length} repair records`, impact: 'The Builder can accumulate ineffective hypotheses.', recommendation: 'Use repair history as a hard anti-loop input and summarize failed attempts.' });
  if (diagnosis?.confidence === 'low') findings.push({ problem: 'Root cause not proven', evidence: diagnosis.rootCause, impact: 'Automatic edits would be risky.', recommendation: 'Collect the missing runtime/build/preview evidence before patching.' });
  if (repeatedRequests.length) findings.push({ problem: 'Repeated user request', evidence: repeatedRequests, impact: 'The workflow may not be resolving the user need in one pass.', recommendation: 'Improve the relevant Builder step or expose a clearer next action instead of asking the user to repeat themselves.' });
  const report = { projectId: project.id, generatedAt: new Date().toISOString(), findings: findings.slice(0, 20), source: { repairHistory: Array.isArray(repairs) ? repairs.length : 0, upgradeHistory: Array.isArray(history) ? history.length : 0, failedJobs: failedJobs.length, userMessages: userMessages.length }, expectedImprovement: 'Fewer repeated repairs, clearer next actions, and evidence-first recovery.' };
  await projects.saveMetadata(project, 'builder-advisor.json', report);
  return report;
}

async function readImportant(sourceDir, files) {
  const chunks = [];
  for (const rel of files) {
    const text = await fs.readFile(path.join(sourceDir, rel), 'utf8').catch(() => '');
    if (text) chunks.push(`FILE ${rel}\n${text.slice(0, 10000)}`);
  }
  return chunks.join('\n\n');
}
function detectStack(files, reads) {
  const pkg = parsePackage(reads); const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  return { framework: deps.next ? 'Next.js' : deps.vite ? 'Vite' : deps.react ? 'React' : deps.vue ? 'Vue' : deps.express ? 'Express' : files.some((f) => f.endsWith('.html')) ? 'Static Web' : 'Unknown', runtime: files.includes('package.json') ? 'Node.js' : files.some((f) => /\.py$/.test(f)) ? 'Python' : 'Unknown', hasPackage: files.includes('package.json'), packageManager: files.includes('package-lock.json') ? 'npm' : files.includes('pnpm-lock.yaml') ? 'pnpm' : files.includes('yarn.lock') ? 'yarn' : null, entryPoints: files.filter((f) => /(^|\/)(server|index|app)\.(js|mjs|cjs|ts|tsx)$/.test(f)).slice(0, 12), docker: files.filter((f) => /(^|\/)(Dockerfile|docker-compose\.ya?ml|compose\.ya?ml)$/.test(f)).slice(0, 12), dependencies: Object.keys(deps).slice(0, 100) };
}
function detectRuntime(reads) {
  const writePaths = new Set(), localhostBinds = [], portHints = new Set();
  for (const block of reads.split(/\n\n(?=FILE )/)) { const m = block.match(/^FILE (.+)\n([\s\S]*)$/); if (!m) continue; const file = m[1], text = m[2]; for (const p of text.matchAll(/(?:mkdir(?:Sync)?|writeFile(?:Sync)?|appendFile(?:Sync)?|createWriteStream)\s*\([^\n]*?['"](\/[A-Za-z0-9_./-]+)['"]/g)) writePaths.add(p[1]); for (const p of text.matchAll(/(?:process\.env\.(?:DATA_DIR|DATABASE_PATH|UPLOAD_DIR|STORAGE_DIR)|['"](?:\/app\/(?:data|uploads|storage|db|cache)|\/data|\/storage)['"])/g)) writePaths.add(p[0]); if (/\.listen\s*\([^\n]*['"](?:127\.0\.0\.1|localhost)['"]/i.test(text)) localhostBinds.push(file); for (const p of text.matchAll(/(?:PORT|EXPOSE|port)\D{0,20}(\d{2,5})/gi)) portHints.add(Number(p[1])); }
  return { writePaths: [...writePaths].slice(0, 30), localhostBinds, portHints: [...portHints].filter((n) => n > 0 && n < 65536) };
}
function parsePackage(reads) { const m = reads.match(/FILE package\.json\n([\s\S]*?)(?=\n\nFILE |$)/); if (!m) return {}; try { return JSON.parse(m[1]); } catch { return {}; } }
function detectRepeatedFailures(history, fingerprint) { if (!fingerprint || fingerprint === 'NONE' || fingerprint === 'UNKNOWN') return []; return history.filter((h) => String(h?.fingerprint || h?.rootCause || '').includes(fingerprint) || String(h?.error || '').includes(fingerprint)).slice(-8); }
function countRepeated(values) { const map = new Map(); for (const value of values) { const key = String(value).replace(/\s+/g, ' ').slice(0, 240); map.set(key, (map.get(key) || 0) + 1); } return [...map.entries()].filter(([, count]) => count > 1).map(([value, count]) => ({ value, count })).slice(0, 10); }
async function manifestOf(dir) { const files = await listFiles(dir), out = []; for (const rel of files) { if (!SOURCE.test(rel) && !IMPORTANT.test(rel)) continue; const data = await fs.readFile(path.join(dir, rel)).catch(() => null); if (!data) continue; out.push({ path: rel.replace(/\\/g, '/'), sha256: crypto.createHash('sha256').update(data).digest('hex'), size: data.length }); } return out; }
async function appendHistory(projects, project, report) { const old = await projects.readMetadata(project, 'diagnosis-history.json', []); const rows = Array.isArray(old) ? old : []; rows.push({ incidentId: report.incidentId, fingerprint: report.fingerprint, rootCause: report.rootCause, confidence: report.confidence, recommendation: report.recommendation, generatedAt: report.generatedAt }); await projects.saveMetadata(project, 'diagnosis-history.json', rows.slice(-50)); }
