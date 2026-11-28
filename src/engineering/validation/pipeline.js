/**
 * Validation pipeline v2 (v1.10.0, M2 / D-06).
 *
 * Every step maps to a real tool or reports NOT_AVAILABLE / NOT_TESTED with a reason — never a fake PASS.
 * Static mode (default, used by shadow) never runs project code. Runtime mode boots the app from a
 * temporary copy, probes HTTP and optionally drives real Chromium. The public entry is wrapped in
 * withSourceGuard so a validation run can never change the user's source (D-01).
 *
 * Steps: structure · intel.fingerprint · intel.deps(+lockfile) · config.solohost · intel.env · code.syntax_check ·
 *   code.imports · code.secret_scan · dare.check (dry run) · code.lint · code.typecheck · intel.routes ·
 *   test.unit · build · runtime.start · runtime.process · http.health · http.routes · browser.desktop ·
 *   browser.mobile · browser.console · report
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { STATUS, mergeStatuses, stepResult } from './status.js';
import { buildFingerprint } from '../intel/fingerprint.js';
import { inspectDeps } from '../intel/deps.js';
import { inspectRoutes } from '../intel/routes.js';
import { inspectEnv } from '../intel/env.js';
import { syntaxCheckProject } from '../diagnostics/syntax.js';
import { checkImports } from '../diagnostics/imports.js';
import { runDareCheck } from '../diagnostics/dare-bridge.js';
import { runBrowserAgent } from '../browser/agent.js';
import { secretScanProject } from '../diagnostics/secrets.js';
import { withSourceGuard } from '../guard.js';
import { execNamed } from '../executor/exec.js';
import { startApp, probeHealth, probeRoutes, prepareRunCopy, depsInstalled, scaledTimeout } from '../runtime/app-runner.js';
import { evaluateAcceptanceCriteria } from './acceptance.js';
import { DEFAULT_MIN_FREE_MB } from '../config.js';

const STATUS_WEIGHT = { FAIL: 10, WARNING: 1, NOT_TESTED: 0, NOT_AVAILABLE: 0, PASS: 0 };

export function validationScore(report) {
  return (report?.steps || []).reduce((n, s) => n + (STATUS_WEIGHT[s.status] || 0), 0);
}

export function defaultTimeBudgetMs(arch = os.arch()) {
  const envBudget = Number(process.env.ENGINEERING_TIME_BUDGET_MS || 0);
  if (envBudget > 0) return envBudget;
  return /^arm|^aarch64/i.test(String(arch || '')) ? 60_000 : 20_000;
}

function currentRssMb() {
  return Math.round(process.memoryUsage().rss / 1048576);
}

async function exists(p) { return fs.access(p).then(() => true).catch(() => false); }
async function readJson(p) { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; } }

async function wrap(promiseOrValue) {
  const t0 = Date.now();
  try {
    const r = await promiseOrValue;
    return { status: r.status || (r.ok ? STATUS.PASS : STATUS.FAIL), message: r.error || r.message || r.data?.message || '', evidence: r.data || r.evidence || null, durationMs: Date.now() - t0, rssMb: currentRssMb() };
  } catch (err) {
    return { status: STATUS.FAIL, message: `tool error: ${String(err.message || err).slice(0, 300)}`, durationMs: Date.now() - t0, rssMb: currentRssMb() };
  }
}

async function structureStep(dir) {
  const pkg = await readJson(path.join(dir, 'package.json'));
  const has = async (f) => exists(path.join(dir, f));
  const entry = (await has('src/server.js')) || (await has('server.js')) || (await has('index.js')) || (await has('app.js')) || Boolean(pkg?.scripts?.start);
  const ui = (await has('public/index.html')) || (await has('index.html'));
  const missing = [];
  if (!pkg) missing.push('package.json');
  if (!(await has('Dockerfile'))) missing.push('Dockerfile');
  if (!(await has('README.md'))) missing.push('README.md');
  if (!entry && !ui) return { status: STATUS.FAIL, message: 'No server entry (server.js / index.js / start script) and no index.html', data: { missing } };
  return { status: missing.length ? STATUS.WARNING : STATUS.PASS, message: missing.length ? `missing: ${missing.join(', ')}` : 'standard files present', data: { missing, hasServer: entry, hasUi: ui } };
}

async function depsStep(dir) {
  const r = await inspectDeps(dir);
  if (!r.ok) return r;
  let missingImports = [];
  try {
    const { findMissingNodeModules } = await import('../../projects/deps-fix.js');
    missingImports = (await findMissingNodeModules(dir)).missing || [];
  } catch { /* optional */ }
  const hasDeps = r.data.dependencies.length + r.data.devDependencies.length > 0;
  const findings = [];
  if (missingImports.length) findings.push({ kind: 'NODE_MODULE_MISSING', message: `imported but not declared in package.json: ${missingImports.join(', ')}` });
  if (hasDeps && r.data.lockfile === 'none') findings.push({ kind: 'MISSING_LOCKFILE', message: 'dependencies declared but no lockfile (builds are not reproducible)' });
  return {
    status: missingImports.length ? STATUS.FAIL : findings.length ? STATUS.WARNING : STATUS.PASS,
    message: findings.map((f) => f.message).join('; '),
    data: { ...r.data, missingImports, findings },
  };
}

async function soloHostStep(dir) {
  const candidates = [['solohost/docker-compose.yml', 'solohost/config_options.yml'], ['docker-compose.yml', 'config_options.yml']];
  for (const [c, k] of candidates) {
    const composeText = await fs.readFile(path.join(dir, c), 'utf8').catch(() => null);
    if (composeText == null) continue;
    const configText = await fs.readFile(path.join(dir, k), 'utf8').catch(() => '');
    try {
      const { lintPackage } = await import('../../release/solohost-lint.js');
      const lint = lintPackage({ composeText, configText });
      // source compose with build: is allowed before publish; only the solohost/ kit must be install-ready
      const errors = (lint.errors || []).filter((e) => c.startsWith('solohost/') || !/BUILD|IMAGE/i.test(e.rule));
      const { detectContainerPort } = await import('../../release/solohost.js');
      const port = await detectContainerPort(dir).catch(() => null);
      return {
        status: errors.length ? (c.startsWith('solohost/') ? STATUS.FAIL : STATUS.WARNING) : (lint.warnings?.length ? STATUS.WARNING : STATUS.PASS),
        message: errors.length ? errors.slice(0, 4).map((e) => `${e.rule}${e.params?.var ? ` ${e.params.var}` : ''}`).join(', ') : (lint.warnings?.length ? `${c}: ${lint.warnings.slice(0, 3).map((w) => `${w.rule}${w.params?.var ? ` ${w.params.var}` : ''}`).join(', ')}` : `${c} lint clean`),
        data: { file: c, errors: errors.slice(0, 10), warnings: (lint.warnings || []).slice(0, 10), containerPort: port },
      };
    } catch (err) {
      return { status: STATUS.NOT_AVAILABLE, message: `SoloHost lint unavailable: ${String(err.message || err).slice(0, 120)}` };
    }
  }
  return { status: STATUS.NOT_AVAILABLE, message: 'no docker-compose.yml to lint' };
}

async function portStep(dir, fingerprint) {
  // Static port contract: the app must read process.env.PORT (SoloHost sets it) and bind all interfaces.
  const entry = fingerprint?.entrypoint && !String(fingerprint.entrypoint).startsWith('script:') ? fingerprint.entrypoint : null;
  if (!entry) return { status: STATUS.NOT_AVAILABLE, message: 'no server entry to inspect' };
  const text = await fs.readFile(path.join(dir, entry), 'utf8').catch(() => '');
  const findings = [];
  const usesPortEnv = /process\.env\.PORT|process\.env\[['"]PORT['"]\]/.test(text);
  const listen = /\.listen\s*\(\s*(\d{2,5})\b/.exec(text);
  if (!usesPortEnv && listen) findings.push({ kind: 'PORT_MISMATCH', line: text.slice(0, listen.index).split('\n').length, message: `${entry} listens on fixed port ${listen[1]} and ignores process.env.PORT` });
  const local = /\.listen\s*\([^\n]*['"](127\.0\.0\.1|localhost)['"]/.exec(text) || /(?:HOST|BIND)\s*=\s*[^;\n]*['"](127\.0\.0\.1|localhost)['"]/.exec(text);
  if (local) findings.push({ kind: 'BIND_ALL_INTERFACES', line: text.slice(0, local.index).split('\n').length, message: `${entry} binds to ${local[1]} — unreachable inside a container` });
  return {
    status: findings.length ? STATUS.FAIL : STATUS.PASS,
    message: findings.map((f) => `${f.message} (${entry}:${f.line})`).join('; ') || 'reads PORT and binds all interfaces',
    data: { entry, findings: findings.map((f) => ({ ...f, file: entry })) },
  };
}

async function optionalScriptStep(dir, script, { configFiles, bin, signal }) {
  const pkg = await readJson(path.join(dir, 'package.json'));
  if (!pkg?.scripts?.[script]) return { status: STATUS.NOT_AVAILABLE, message: `no "${script}" script` };
  const hasConfig = [];
  for (const f of configFiles) if (await exists(path.join(dir, f))) hasConfig.push(f);
  if (!hasConfig.length) return { status: STATUS.NOT_AVAILABLE, message: `no ${configFiles[0]}-style config shipped` };
  if (!(await exists(path.join(dir, 'node_modules', '.bin', bin)))) return { status: STATUS.NOT_AVAILABLE, message: `local ${bin} binary not installed` };
  const copy = await prepareRunCopy(dir);
  try {
    const r = await execNamed('npm.run', [script], { projectRoot: copy.dir, timeoutMs: scaledTimeout(60_000), signal });
    return { status: r.status, message: r.ok ? `${script} passed` : `${script}: ${(r.stderrTail || r.stdoutTail || r.error || '').split('\n').filter(Boolean).slice(-3).join(' | ')}`.slice(0, 500), data: { exitCode: r.exitCode, classification: r.classification } };
  } finally { await copy.cleanup(); }
}

function isRealTestScript(body) {
  const s = String(body || '').trim();
  return Boolean(s) && !/no test specified|exit 1\s*$/.test(s) && !/^echo\b/.test(s);
}

async function unitTestStep(dir, { tests, signal }) {
  if (!tests) return { status: STATUS.NOT_TESTED, message: 'not requested (static mode)' };
  const pkg = await readJson(path.join(dir, 'package.json'));
  const body = pkg?.scripts?.test;
  if (!isRealTestScript(body)) return { status: STATUS.NOT_AVAILABLE, message: 'no real test script in package.json' };
  const deps = await depsInstalled(dir);
  const hasDev = Object.keys(pkg?.devDependencies || {}).length > 0;
  if (!deps.ok || (hasDev && !(await exists(path.join(dir, 'node_modules'))))) return { status: STATUS.NOT_TESTED, message: 'dependencies are not installed — tests not run' };
  const copy = await prepareRunCopy(dir);
  try {
    const r = await execNamed('npm.test', [], { projectRoot: copy.dir, timeoutMs: scaledTimeout(90_000), signal });
    const label = /smoke/i.test(body) ? 'smoke' : 'unit';
    return {
      status: r.status,
      message: r.ok ? `${label} tests passed` : `${label} tests: ${(r.stderrTail || r.stdoutTail || r.error || '').split('\n').filter((l) => /not ok|Error|fail/i.test(l)).slice(0, 4).join(' | ') || r.error}`.slice(0, 600),
      data: { kind: label, exitCode: r.exitCode, classification: r.classification, durationMs: r.durationMs },
    };
  } finally { await copy.cleanup(); }
}

async function buildStep(dir, { tests, signal }) {
  const pkg = await readJson(path.join(dir, 'package.json'));
  if (!pkg?.scripts?.build) return { status: STATUS.NOT_AVAILABLE, message: 'no build script' };
  if (!tests) return { status: STATUS.NOT_TESTED, message: 'not requested (static mode)' };
  const copy = await prepareRunCopy(dir);
  try {
    const r = await execNamed('npm.build', [], { projectRoot: copy.dir, timeoutMs: scaledTimeout(120_000), signal });
    return { status: r.status, message: r.ok ? 'build passed' : `build: ${(r.stderrTail || r.error || '').split('\n').filter(Boolean).slice(-3).join(' | ')}`.slice(0, 500), data: { exitCode: r.exitCode, classification: r.classification } };
  } finally { await copy.cleanup(); }
}

function summarize(steps, locale = 'en') {
  const bad = steps.filter((s) => s.status === STATUS.FAIL);
  const warn = steps.filter((s) => s.status === STATUS.WARNING);
  const en = bad.length
    ? `${bad.length} check(s) failed: ${bad.slice(0, 4).map((s) => s.id).join(', ')}.`
    : warn.length ? `No failures; ${warn.length} warning(s): ${warn.slice(0, 4).map((s) => s.id).join(', ')}.` : 'All executed checks passed.';
  const vi = bad.length
    ? `${bad.length} kiểm tra không đạt: ${bad.slice(0, 4).map((s) => s.id).join(', ')}.`
    : warn.length ? `Không có lỗi; ${warn.length} cảnh báo: ${warn.slice(0, 4).map((s) => s.id).join(', ')}.` : 'Tất cả kiểm tra đã chạy đều đạt.';
  return locale === 'vi' ? vi : en;
}

/** Collect structured findings (file:line) from all steps — used by DARE v2, evidence and repair loops. */
export function collectFindings(report) {
  const out = [];
  for (const s of report?.steps || []) {
    if (s.status !== STATUS.FAIL && s.status !== STATUS.WARNING) continue;
    const ev = s.evidence || {};
    const list = ev.findings || ev.failed || [];
    if (Array.isArray(list) && list.length) {
      for (const f of list.slice(0, 10)) out.push({ step: s.id, status: s.status, kind: f.kind || f.type || f.code || s.id, file: f.file || f.path || null, line: f.line || null, message: f.message || f.error || String(f.reason || ''), path: f.path || null, method: f.method || null, fix: f.fix || null, spec: f.spec || null, name: f.name || null });
    } else if (s.id === 'http.routes' && ev.results) {
      for (const r of ev.results.filter((x) => x.verdict === STATUS.FAIL)) out.push({ step: s.id, status: s.status, kind: 'ROUTE_PROBE', file: r.file || null, line: r.line || null, path: r.path, message: `GET ${r.path} → ${r.note}` });
    } else {
      out.push({ step: s.id, status: s.status, kind: ev.finding || ev.classification?.class || s.id, file: ev.file || null, line: ev.line || null, message: s.message });
    }
  }
  return out;
}

async function runPipelineInner(sourceDir, opts) {
  const {
    stopOnFail = false,
    baseUrl = null,
    runtime = false,
    browser = false,
    tests = false,
    artifactsDir = null,
    signal,
    locale = 'en',
    probeInternet = false,
    budgetMs = defaultTimeBudgetMs(),
    onProgress = null,
    acceptanceChecks = null,
    adaptive = true,
  } = opts;

  const startedAt = Date.now();
  const steps = [];
  const stepMetrics = [];
  let peakRssMb = currentRssMb();
  let earlyStopped = false;
  let earlyReason = '';

  const push = (id, r) => {
    const rssMb = r.rssMb ?? currentRssMb();
    if (rssMb > peakRssMb) peakRssMb = rssMb;
    const s = stepResult({ id, ...r });
    steps.push(s);
    stepMetrics.push({ id: s.id, status: s.status, durationMs: s.durationMs ?? 0, rssMb });
    try { onProgress?.({ stepId: s.id, status: s.status, durationMs: s.durationMs ?? 0, rssMb, elapsedMs: Date.now() - startedAt, budgetMs }); } catch {}
    return s;
  };
  const failed = () => stopOnFail && steps.at(-1)?.status === STATUS.FAIL;
  const hasBlockingFail = () => steps.some((s) => s.status === STATUS.FAIL);
  const shouldStop = () => {
    if (signal?.aborted) {
      earlyStopped = true;
      earlyReason = 'cancelled';
      return true;
    }
    if (budgetMs > 0 && (Date.now() - startedAt) > budgetMs && hasBlockingFail()) {
      earlyStopped = true;
      earlyReason = 'over budget after blocking failure';
      return true;
    }
    return false;
  };

  const ctx = {};
  const finish = () => finalize(steps, locale, {
    startedAt,
    budgetMs,
    peakRssMb,
    stepMetrics,
    earlyStopped,
    earlyReason,
    acceptanceChecks,
  });

  if (shouldStop()) return finish();
  push('structure', await wrap(structureStep(sourceDir)));
  if (failed() || shouldStop()) return finish();

  const fp = await wrap(buildFingerprint(sourceDir));
  ctx.fingerprint = fp.evidence || {};
  push('intel.fingerprint', fp);
  if (shouldStop()) return finish();

  push('intel.deps', await wrap(depsStep(sourceDir)));
  push('config.solohost', await wrap(soloHostStep(sourceDir)));
  push('config.port', await wrap(portStep(sourceDir, ctx.fingerprint)));
  push('intel.env', await wrap(inspectEnv(sourceDir)));
  push('code.syntax_check', await wrap(syntaxCheckProject(sourceDir)));
  if (failed() || shouldStop()) return finish();

  push('code.imports', await wrap(checkImports(sourceDir)));
  push('code.secret_scan', await wrap(secretScanProject(sourceDir)));
  if (failed() || shouldStop()) return finish();

  push('dare.check', await wrap(runDareCheck(sourceDir)));
  if (!shouldStop()) push('code.lint', await wrap(optionalScriptStep(sourceDir, 'lint', { configFiles: ['eslint.config.js', 'eslint.config.mjs', '.eslintrc', '.eslintrc.json', '.eslintrc.js', '.eslintrc.cjs'], bin: 'eslint', signal })));
  if (!shouldStop()) push('code.typecheck', await wrap(optionalScriptStep(sourceDir, 'typecheck', { configFiles: ['tsconfig.json'], bin: 'tsc', signal })));

  const routesStep = await wrap(inspectRoutes(sourceDir));
  push('intel.routes', routesStep);
  const routeData = routesStep.evidence || {};

  if (!shouldStop()) push('test.unit', await wrap(unitTestStep(sourceDir, { tests, signal })));
  else push('test.unit', { status: STATUS.NOT_TESTED, message: earlyReason || 'skipped (over budget / cancelled)' });

  if (!shouldStop()) push('build', await wrap(buildStep(sourceDir, { tests, signal })));
  else push('build', { status: STATUS.NOT_TESTED, message: earlyReason || 'skipped (over budget / cancelled)' });

  let app = null;
  let liveUrl = baseUrl;
  try {
    if (shouldStop()) {
      for (const id of ['runtime.start', 'runtime.process', 'http.health', 'http.routes', 'browser.desktop', 'browser.mobile', 'browser.console']) {
        push(id, { status: STATUS.NOT_TESTED, message: earlyReason || 'skipped (cancelled or over budget)' });
      }
      return finish();
    }

    if (runtime && !baseUrl) {
      const remaining = Math.max(4000, budgetMs - (Date.now() - startedAt));
      const startTimeout = opts.startTimeoutMs || Math.min(scaledTimeout(20_000), Math.max(4000, remaining));
      const started = await startApp(sourceDir, { fingerprint: ctx.fingerprint, timeoutMs: startTimeout, signal });
      app = started.app || null;
      liveUrl = started.baseUrl || null;
      push('runtime.start', { status: started.status, message: started.message, evidence: { port: started.port, logs: started.logs, classification: started.classification, file: started.file, line: started.line, finding: started.classification?.class === 'PORT_MISMATCH' ? 'PORT_MISMATCH' : undefined } });
    } else {
      push('runtime.start', { status: baseUrl ? STATUS.PASS : STATUS.NOT_TESTED, message: baseUrl ? `using provided baseUrl ${baseUrl}` : 'runtime verification not requested (static mode)' });
    }
    if (liveUrl && !shouldStop()) {
      const alive = app ? !app.handle.exited : true;
      push('runtime.process', { status: alive ? STATUS.PASS : STATUS.FAIL, message: alive ? 'process alive' : 'process exited after startup', evidence: app ? { pid: app.handle.pid } : null });
      push('http.health', await wrap(probeHealth(liveUrl, { routes: routeData.routes || [] })));
      if (!shouldStop()) {
        push('http.routes', await wrap(probeRoutes(liveUrl, { serverRoutes: routeData.serverRoutes || [], clientCalls: routeData.clientCalls || [] })));
      } else {
        push('http.routes', { status: STATUS.NOT_TESTED, message: earlyReason });
      }
      if (app && app.handle.exited) {
        const logs = app.handle.logs();
        push('runtime.crash', { status: STATUS.FAIL, message: `process crashed while probing: ${`${logs.stderrTail}`.split('\n').filter(Boolean).slice(-2).join(' | ')}`.slice(0, 400) });
      }
      if (browser && !shouldStop()) {
        const freeMb = typeof opts.freeMemMb === 'number' ? opts.freeMemMb : Math.round(os.freemem() / 1048576);
        const lowRamSkipMobile = opts.skipMobile === true || (adaptive && freeMb < DEFAULT_MIN_FREE_MB);
        const viewports = lowRamSkipMobile ? ['desktop'] : ['desktop', 'mobile'];
        const b = await wrap(runBrowserAgent({
          baseUrl: liveUrl,
          routes: (routeData.routes || []).slice(0, 8),
          viewports,
          artifactsDir,
          probeInternet,
          timeoutMs: scaledTimeout(45_000),
          signal,
        }));
        const views = b.evidence?.viewports || {};
        const pick = (v) => {
          if (v === 'mobile' && lowRamSkipMobile) {
            return { status: STATUS.NOT_TESTED, message: `mobile browser pass skipped (free RAM ${freeMb} MB < ${DEFAULT_MIN_FREE_MB} MB)` };
          }
          if (!views[v]) return { status: b.status === STATUS.NOT_AVAILABLE ? STATUS.NOT_AVAILABLE : b.status, message: b.message, evidence: b.evidence };
          const f = views[v].findings || [];
          const errs = f.filter((x) => x.severity === 'error');
          const warns = f.filter((x) => x.severity === 'warning' && x.code !== 'THIRD_PARTY');
          return { status: errs.length ? STATUS.FAIL : warns.length ? STATUS.WARNING : STATUS.PASS, message: [...errs, ...warns].slice(0, 4).map((x) => x.message).join('; ') || `${v} QA passed`, evidence: { findings: f.slice(0, 30).map((x) => ({ ...x, kind: x.code })), visits: views[v].visits, interactions: views[v].interactions, screenshots: views[v].screenshots, checks: views[v].checks } };
        };
        push('browser.desktop', pick('desktop'));
        push('browser.mobile', pick('mobile'));
        const all = Object.values(views);
        const cons = all.flatMap((v) => [...(v.consoleErrors || []), ...(v.pageErrors || [])]);
        push('browser.console', { status: !all.length ? (b.status === STATUS.NOT_AVAILABLE ? STATUS.NOT_AVAILABLE : b.status === STATUS.NOT_TESTED ? STATUS.NOT_TESTED : STATUS.NOT_TESTED) : cons.length ? STATUS.FAIL : STATUS.PASS, message: cons.slice(0, 3).join(' | ') || (all.length ? 'no console/page errors' : b.message), evidence: { internet: b.evidence?.environment?.internet || null } });
      } else {
        const msg = shouldStop() ? (earlyReason || 'skipped (over budget / cancelled)') : 'browser QA not requested';
        for (const id of ['browser.desktop', 'browser.mobile', 'browser.console']) push(id, { status: STATUS.NOT_TESTED, message: msg });
      }
    } else {
      const msg = shouldStop() ? (earlyReason || 'skipped (over budget / cancelled)') : (runtime ? 'app did not start' : 'runtime verification not requested (static mode)');
      for (const id of ['runtime.process', 'http.health', 'http.routes']) push(id, { status: STATUS.NOT_TESTED, message: msg });
      for (const id of ['browser.desktop', 'browser.mobile', 'browser.console']) push(id, { status: STATUS.NOT_TESTED, message: shouldStop() ? msg : 'No running app / baseUrl — browser QA not run' });
    }
  } finally {
    if (app) await app.stop().catch(() => {});
  }
  return finish();
}

function finalize(steps, locale, meta = {}) {
  const overall = mergeStatuses(steps.map((s) => s.status));
  const totalDurationMs = Math.max(0, Date.now() - (meta.startedAt || Date.now()));
  const budgetMs = Number(meta.budgetMs || 0);
  const report = {
    ok: overall !== STATUS.FAIL,
    status: overall,
    steps,
    summary: steps.map((s) => `${s.id}:${s.status}`).join(' · '),
    summaryEn: summarize(steps, 'en'),
    summaryVi: summarize(steps, 'vi'),
    at: new Date().toISOString(),
    metrics: {
      totalDurationMs,
      budgetMs,
      overBudget: budgetMs > 0 ? totalDurationMs > budgetMs : false,
      earlyStopped: Boolean(meta.earlyStopped),
      earlyReason: meta.earlyReason || '',
      peakRssMb: meta.peakRssMb ?? currentRssMb(),
      steps: meta.stepMetrics || [],
    },
  };
  if (Array.isArray(meta.acceptanceChecks) && meta.acceptanceChecks.length) {
    report.acceptanceCriteria = evaluateAcceptanceCriteria(meta.acceptanceChecks, report);
  }
  report.score = validationScore(report);
  report.findings = collectFindings(report);
  report.steps.push(stepResult({ id: 'report', status: overall, message: locale === 'vi' ? report.summaryVi : report.summaryEn }));
  return report;
}

/**
 * @param {string} sourceDir
 * @param {{ stopOnFail?: boolean, baseUrl?: string, runtime?: boolean, browser?: boolean, tests?: boolean,
 *   artifactsDir?: string, signal?: AbortSignal, locale?: string, guard?: boolean, saveReport?: string,
 *   saveMetrics?: string, acceptanceChecks?: Array<string|object>, budgetMs?: number, onProgress?: function,
 *   skipMobile?: boolean, freeMemMb?: number, adaptive?: boolean }} opts
 */
export async function runValidationPipeline(sourceDir, opts = {}) {
  const run = () => runPipelineInner(sourceDir, opts);
  const report = opts.guard === false ? await run() : await withSourceGuard(sourceDir, run, { label: 'validation pipeline' });
  if (opts.saveReport) {
    await fs.mkdir(path.dirname(opts.saveReport), { recursive: true }).catch(() => {});
    await fs.writeFile(opts.saveReport, JSON.stringify(report, null, 2)).catch(() => {});
  }
  if (opts.saveMetrics) {
    await fs.mkdir(path.dirname(opts.saveMetrics), { recursive: true }).catch(() => {});
    await fs.writeFile(opts.saveMetrics, JSON.stringify({ at: report.at, ...report.metrics }, null, 2)).catch(() => {});
  }
  return report;
}
