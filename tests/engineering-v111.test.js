/**
 * v1.11.0 Engineering Toolkit tests — N1..N6 verification suite.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function makeFakeDb(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    setting: (k, d = null) => (store.has(k) ? store.get(k) : d),
    setSetting: (k, v) => { store.set(k, v); },
  };
}

// ========================================================================= N1
test('N1: mode precedence env > settings > default shadow, and auto resolution matrix', async () => {
  const { resolveEngineeringState, setRuntimeEngineeringSettings } = await import('../src/engineering/config.js');
  setRuntimeEngineeringSettings(null);

  // 1) Unset env & unset settings → shadow (decision: Pi budget not yet verified on hardware)
  await withEnv({ ENGINEERING_TOOLKIT: undefined }, async () => {
    const st = resolveEngineeringState({ cfg: {}, db: makeFakeDb() });
    assert.equal(st.mode, 'shadow');
    assert.equal(st.envLocked, false);
    assert.equal(st.features.runtimeValidation, true);
  });

  // 2) Settings 'on' overrides default when env is unset
  await withEnv({ ENGINEERING_TOOLKIT: undefined }, async () => {
    const db = makeFakeDb({ engineeringSettings: { mode: 'on', features: { browserQa: false } } });
    const st = resolveEngineeringState({ cfg: {}, db });
    assert.equal(st.mode, 'on');
    assert.equal(st.source, 'settings');
    assert.equal(st.features.browserQa, false);
    assert.equal(st.features.runtimeValidation, true);
  });

  // 3) Env ENGINEERING_TOOLKIT overrides Settings
  await withEnv({ ENGINEERING_TOOLKIT: 'off' }, async () => {
    const db = makeFakeDb({ engineeringSettings: { mode: 'on' } });
    const st = resolveEngineeringState({ cfg: {}, db });
    assert.equal(st.mode, 'off');
    assert.equal(st.source, 'env');
    assert.equal(st.envLocked, true);
  });

  // 4) Auto with Chromium + >= 1.5 GB free RAM on x64 → on
  await withEnv({ ENGINEERING_TOOLKIT: 'auto' }, async () => {
    const st = resolveEngineeringState({
      cfg: {},
      detectors: { hasChromium: () => '/usr/bin/chromium', freeMemBytes: () => 2048 * 1048576, totalMemBytes: () => 4096 * 1048576, arch: () => 'x64' },
    });
    assert.equal(st.mode, 'on');
    assert.equal(st.source, 'auto');
    assert.match(st.reason, /on/i);
  });

  // 5) Auto without Chromium → shadow
  await withEnv({ ENGINEERING_TOOLKIT: 'auto' }, async () => {
    const st = resolveEngineeringState({
      cfg: {},
      detectors: { hasChromium: () => null, freeMemBytes: () => 4096 * 1048576, totalMemBytes: () => 8192 * 1048576, arch: () => 'x64' },
    });
    assert.equal(st.mode, 'shadow');
    assert.match(st.reason, /Chromium/i);
  });

  // 6) Auto with Chromium but low free RAM → shadow
  await withEnv({ ENGINEERING_TOOLKIT: 'auto' }, async () => {
    const st = resolveEngineeringState({
      cfg: {},
      detectors: { hasChromium: () => '/usr/bin/chromium', freeMemBytes: () => 512 * 1048576, totalMemBytes: () => 4096 * 1048576, arch: () => 'x64' },
    });
    assert.equal(st.mode, 'shadow');
    assert.match(st.reason, /RAM/i);
  });

  // 7) Auto on ARM low-RAM → shadow
  await withEnv({ ENGINEERING_TOOLKIT: 'auto' }, async () => {
    const st = resolveEngineeringState({
      cfg: {},
      detectors: { hasChromium: () => '/usr/bin/chromium', freeMemBytes: () => 1600 * 1048576, totalMemBytes: () => 1536 * 1048576, arch: () => 'arm64' },
    });
    assert.equal(st.mode, 'shadow');
    assert.match(st.reason, /ARM/i);
  });

  setRuntimeEngineeringSettings(null);
});

test('N1: Settings API toggles mode & sub-switches live without restart and health reflects source/reason', async () => {
  const { registerRoutes } = await import('../src/api/routes.js');
  const { createEngineeringToolkit } = await import('../src/engineering/index.js');
  const { setRuntimeEngineeringSettings } = await import('../src/engineering/config.js');
  setRuntimeEngineeringSettings(null);

  await withEnv({ ENGINEERING_TOOLKIT: undefined }, async () => {
    const db = makeFakeDb();
    const engineering = createEngineeringToolkit({ cfg: {}, db });
    const handlers = {};
    const r = new Proxy({}, {
      get: (_t, method) => (routePath, fn) => {
        if (typeof routePath === 'string' && typeof fn === 'function') {
          handlers[`${String(method).toUpperCase()} ${routePath}`] = fn;
        }
      },
    });
    const app = {
      cfg: { templatesDir: '/nonexistent', ai: { provider: 'deepseek', mode: 'single' }, github: {}, limits: {}, runtime: { mode: 'auto', podman: {} }, feedbackHub: {} },
      db,
      jobs: { isBusy: () => false, list: () => [] },
      projects: { list: () => [] },
      snapshots: {},
      github: { configured: () => false },
      releases: {},
      runner: { status: () => ({}) },
      ai: { status: () => ({}), refresh: () => {} },
      engineering,
    };
    registerRoutes(r, app);

    const invoke = async (key, body = {}) => {
      let payload = null;
      const req = { body, query: {}, params: {} };
      const res = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        json(v) { payload = v; return this; },
      };
      await handlers[key](req, res);
      return payload;
    };

    const h1 = await invoke('GET /api/engineering/health');
    assert.equal(h1.mode, 'shadow');
    assert.equal(h1.source, 'auto');
    assert.ok(h1.reason && h1.reasonVi);

    const s1 = await invoke('POST /api/settings', {
      engineeringMode: 'on',
      engineeringFeatures: { browserQa: false, autoRollback: false },
    });
    assert.equal(s1.engineering.mode, 'on');
    assert.equal(s1.engineering.source, 'settings');
    assert.equal(engineering.mode, 'on');
    assert.equal(engineering.active, true);
    assert.equal(engineering.features.browserQa, false);
    assert.equal(engineering.features.autoRollback, false);
    assert.equal(engineering.features.runtimeValidation, true);

    const h2 = await invoke('GET /api/engineering/health');
    assert.equal(h2.mode, 'on');
    assert.equal(h2.source, 'settings');

    // Toggle back to off
    await invoke('POST /api/settings', { engineeringMode: 'off' });
    assert.equal(engineering.mode, 'off');
    assert.equal(engineering.active, false);
  });

  setRuntimeEngineeringSettings(null);
});

test('N1: compose files include ENGINEERING_TOOLKIT=auto and config_options keeps <= 2 fields', async () => {
  for (const rel of ['docker-compose.yml', 'SOLOHOST-docker-compose.yml', 'solohost/docker-compose.yml']) {
    const text = await fs.readFile(path.resolve(rel), 'utf8');
    assert.match(text, /ENGINEERING_TOOLKIT:\s*"auto"/, `${rel} missing ENGINEERING_TOOLKIT: "auto"`);
    assert.match(text, /:1\.11\.0/, `${rel} should reference image tag 1.11.0`);
  }
  for (const rel of ['config_options.yml', 'SOLOHOST-config_options.yml', 'solohost/config_options.yml']) {
    const text = await fs.readFile(path.resolve(rel), 'utf8');
    assert.match(text, /ENGINEERING_TOOLKIT/, `${rel} should document ENGINEERING_TOOLKIT`);
    assert.match(text, /^fields:\s*\[\]\s*$/m, `${rel} must keep fields: [] (<= 2 fields)`);
  }
});

// ========================================================================= N2
test('N2: Golden EN and VI quality reports & truthfulness guard across PASS, WARNING, FAIL-after-rollback, NOT_TESTED-no-Chromium', async () => {
  const { formatQualityReport, canClaimWorking, detectReportLocale } = await import('../src/engineering/report.js');
  const { STATUS } = await import('../src/engineering/validation/status.js');

  assert.equal(detectReportLocale('Tạo app bán hàng với giỏ hàng'), 'vi');
  assert.equal(detectReportLocale('Build a CRM dashboard app'), 'en');

  // 1) PASS (Chromium present and desktop passed)
  const passReport = {
    status: STATUS.PASS,
    steps: [
      { id: 'code.syntax_check', status: STATUS.PASS },
      { id: 'runtime.start', status: STATUS.PASS },
      { id: 'http.health', status: STATUS.PASS },
      { id: 'http.routes', status: STATUS.PASS },
      { id: 'browser.desktop', status: STATUS.PASS },
      { id: 'browser.console', status: STATUS.PASS },
    ],
    acceptanceCriteria: { criteria: [{ text: 'Health responds ok', status: STATUS.PASS }], summary: { total: 1, pass: 1, fail: 0, notTested: 0 } },
  };
  assert.equal(canClaimWorking(passReport, { hasChromium: true }), true);
  const enPass = formatQualityReport({ report: passReport, locale: 'en', dareFixes: ['PORT_MISMATCH (src/server.js)'] });
  assert.match(enPass, /✓ Working/);
  assert.match(enPass, /✓ PASS runtime\.start/);
  assert.match(enPass, /Auto-fixed \(DARE\): PORT_MISMATCH/);

  const viPass = formatQualityReport({ report: passReport, locale: 'vi', dareFixes: ['PORT_MISMATCH (src/server.js)'] });
  assert.match(viPass, /✓ Hoạt động tốt/);
  assert.match(viPass, /Tự động sửa \(DARE\): PORT_MISMATCH/);

  // 2) WARNING (routes warning, runtime/browser ok)
  const warnReport = {
    status: STATUS.WARNING,
    steps: [
      { id: 'runtime.start', status: STATUS.PASS },
      { id: 'http.health', status: STATUS.PASS },
      { id: 'http.routes', status: STATUS.WARNING, message: '1 unmatched route' },
      { id: 'browser.desktop', status: STATUS.PASS },
    ],
  };
  assert.equal(canClaimWorking(warnReport, { hasChromium: true }), true);
  assert.match(formatQualityReport({ report: warnReport, locale: 'en' }), /⚠ Working \(1 warning\(s\)\)/);
  assert.match(formatQualityReport({ report: warnReport, locale: 'vi' }), /⚠ Hoạt động tốt \(có 1 cảnh báo\)/);

  // 3) FAIL-after-rollback (never claims working!)
  const failReport = {
    status: STATUS.FAIL,
    steps: [
      { id: 'runtime.start', status: STATUS.PASS },
      { id: 'http.health', status: STATUS.FAIL, message: 'GET /health -> 500' },
      { id: 'browser.desktop', status: STATUS.NOT_AVAILABLE },
    ],
  };
  assert.equal(canClaimWorking(failReport, { hasChromium: false }), false);
  const enFail = formatQualityReport({ report: failReport, locale: 'en', rollback: 'http.health regressed', aiFixes: ['src/server.js — FAIL'] });
  assert.doesNotMatch(enFail, /✓ Working/);
  assert.match(enFail, /Partially done \/ Needs attention — failing step: http\.health/);
  assert.match(enFail, /✗ FAIL http\.health/);
  assert.match(enFail, /Rollback: http\.health regressed/);

  const viFail = formatQualityReport({ report: failReport, locale: 'vi', rollback: 'http.health lỗi' });
  assert.match(viFail, /Hoàn thành một phần \/ Cần kiểm tra thêm — lỗi tại: http\.health/);
  assert.match(viFail, /Hoàn tác \(Rollback\): http\.health lỗi/);

  // 4) NOT_TESTED / no Chromium (runtime & health PASS, browser NOT_AVAILABLE)
  const noChromReport = {
    status: STATUS.PASS,
    steps: [
      { id: 'runtime.start', status: STATUS.PASS },
      { id: 'http.health', status: STATUS.PASS },
      { id: 'browser.desktop', status: STATUS.NOT_AVAILABLE, message: 'Chromium not installed' },
    ],
    acceptanceCriteria: {
      criteria: [{ text: 'Custom widget interaction', status: STATUS.NOT_TESTED }],
    },
  };
  // When Chromium is absent, runtime.start + http.health PASS allows working status while honestly printing NOT_AVAILABLE & NOT_TESTED criteria
  assert.equal(canClaimWorking(noChromReport, { hasChromium: false }), true);
  // If Chromium IS present on the machine but desktop stayed NOT_AVAILABLE / NOT_TESTED → cannot claim working!
  assert.equal(canClaimWorking(noChromReport, { hasChromium: true }), false);
  const enNoChrom = formatQualityReport({ report: noChromReport, locale: 'en', hasChromium: false });
  assert.match(enNoChrom, /– NOT_AVAILABLE browser\.desktop/);
  assert.match(enNoChrom, /NOT_TESTED: Custom widget interaction/);
  const viNoChrom = formatQualityReport({ report: noChromReport, locale: 'vi', hasChromium: false });
  assert.match(viNoChrom, /– NOT_AVAILABLE browser\.desktop/);
  assert.match(viNoChrom, /chưa kiểm tra: Custom widget interaction/);
});

// ========================================================================= N3
test('N3: adaptive budget defaults, progress callbacks, metrics peakRssMb, and AbortSignal cancel cleanup', async () => {
  const { defaultTimeBudgetMs, runValidationPipeline } = await import('../src/engineering/validation/pipeline.js');
  const { execControlled, liveAppCount } = await import('../src/engineering/executor/exec.js');

  assert.equal(defaultTimeBudgetMs('arm64'), 60_000);
  assert.equal(defaultTimeBudgetMs('x64'), 20_000);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'n3-valid-'));
  const metricsFile = path.join(dir, 'engineering-metrics.json');
  try {
    await fs.cp(path.resolve('templates/std-business-crm'), dir, { recursive: true });
    const events = [];
    const report = await runValidationPipeline(dir, {
      runtime: true,
      browser: false,
      saveMetrics: metricsFile,
      onProgress: (ev) => events.push(ev),
    });
    assert.ok(events.length >= 5, 'progress events emitted per step');
    assert.ok(report.metrics?.peakRssMb > 0, 'peakRssMb recorded');
    assert.ok(Array.isArray(report.metrics?.steps) && report.metrics.steps.length >= 5);
    const saved = JSON.parse(await fs.readFile(metricsFile, 'utf8'));
    assert.equal(saved.peakRssMb, report.metrics.peakRssMb);

    // AbortSignal cancellation mid-flight kills child processes cleanly (no orphans)
    const ac = new AbortController();
    await fs.writeFile(path.join(dir, 'sleep-forever.js'), 'setInterval(() => {}, 1000);\n');
    const p = execControlled(['node', 'sleep-forever.js'], { projectRoot: dir, timeoutMs: 30_000, signal: ac.signal });
    setTimeout(() => ac.abort(), 150);
    const res = await p;
    assert.equal(res.cancelled, true);
    assert.equal(liveAppCount(), 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ========================================================================= N4
test('N4: scriptBodyAllowed blocks node -e and external absolute paths; Node --permission denies reads outside projectRoot', async () => {
  const { scriptBodyAllowed } = await import('../src/engineering/executor/policy.js');
  const { execNamed, supportsNodePermission } = await import('../src/engineering/executor/exec.js');

  assert.equal(scriptBodyAllowed('node server.js').ok, true);
  assert.equal(scriptBodyAllowed('node -e "console.log(1)"').ok, false);
  assert.equal(scriptBodyAllowed('npm test && node --eval "require(\'fs\')"').ok, false);
  assert.equal(scriptBodyAllowed('node --require ./x.js server.js').ok, false);
  assert.equal(scriptBodyAllowed('cat /etc/passwd').ok, false);
  assert.equal(scriptBodyAllowed('node reader.js /app/data/db.json').ok, false);

  if (!supportsNodePermission()) return; // Guarded cleanly on older Node

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'n4-perm-'));
  const sentinel = path.join(os.tmpdir(), `n4-secret-${process.pid}-${Date.now()}.txt`);
  await fs.writeFile(sentinel, 'TOP_SECRET_VALUE\n');
  try {
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'perm-test', version: '1.0.0', type: 'module' }));
    await fs.writeFile(path.join(dir, 'steal.js'), [
      "import fs from 'node:fs';",
      `console.log(fs.readFileSync(${JSON.stringify(sentinel)}, 'utf8'));`,
    ].join('\n'));
    const r = await execNamed('node.start', ['steal.js'], { projectRoot: dir, timeoutMs: 8000 });
    assert.notEqual(r.exitCode, 0);
    assert.match(r.stderrTail + r.stdoutTail, /ERR_ACCESS_DENIED|AccessDenied/i);
    assert.doesNotMatch(r.stdoutTail, /TOP_SECRET_VALUE/);

    // Same script reading inside projectRoot is permitted
    await fs.writeFile(path.join(dir, 'inside.txt'), 'ALLOWED_LOCAL_READ');
    await fs.writeFile(path.join(dir, 'ok.js'), "import fs from 'node:fs';\nconsole.log(fs.readFileSync('./inside.txt', 'utf8'));\n");
    const rOk = await execNamed('node.start', ['ok.js'], { projectRoot: dir, timeoutMs: 8000 });
    assert.equal(rOk.exitCode, 0);
    assert.match(rOk.stdoutTail, /ALLOWED_LOCAL_READ/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(sentinel, { force: true }).catch(() => {});
  }
});

// ========================================================================= N5
test('N5: evaluateAcceptanceCriteria maps plan.acceptance_checks deterministically and keeps unknown/unrun checks NOT_TESTED', async () => {
  const { evaluateAcceptanceCriteria } = await import('../src/engineering/validation/acceptance.js');
  const { STATUS } = await import('../src/engineering/validation/status.js');

  const fakeReport = {
    steps: [
      { id: 'http.health', status: STATUS.PASS, message: '200 OK' },
      { id: 'browser.desktop', status: STATUS.PASS, evidence: { checks: { bodyTextLength: 140, emptyStateVisible: true }, interactions: { clicks: [{ changed: true }], forms: [] } } },
      { id: 'browser.mobile', status: STATUS.PASS, evidence: { checks: { overflowX: false } } },
    ],
  };

  const out = evaluateAcceptanceCriteria([
    'Health endpoint returns 200 OK',
    'User can trigger the primary action',
    'Empty state is handled gracefully when no data exists',
    'Mobile responsive layout with no horizontal overflow at 390px',
    'Exports signed PDF invoice with QR code',
  ], fakeReport);

  assert.equal(out.criteria.length, 5);
  assert.equal(out.criteria[0].status, STATUS.PASS);
  assert.equal(out.criteria[1].status, STATUS.PASS);
  assert.equal(out.criteria[2].status, STATUS.PASS);
  assert.equal(out.criteria[3].status, STATUS.PASS);
  assert.equal(out.criteria[4].status, STATUS.NOT_TESTED);
  assert.equal(out.summary.pass, 4);
  assert.equal(out.summary.notTested, 1);

  // Without browser checks, browser criteria MUST remain NOT_TESTED (never guessed PASS)
  const noBrowserReport = { steps: [{ id: 'http.health', status: STATUS.PASS }, { id: 'browser.desktop', status: STATUS.NOT_AVAILABLE }] };
  const outNoBrowser = evaluateAcceptanceCriteria(['Empty state shows helpful prompt', 'Mobile layout works at 390px'], noBrowserReport);
  assert.equal(outNoBrowser.criteria[0].status, STATUS.NOT_TESTED);
  assert.equal(outNoBrowser.criteria[1].status, STATUS.NOT_TESTED);
});

// ========================================================================= N6
test('N6: eval-ai-repair skips cleanly with NOT_TESTED when no provider key is set', async () => {
  const tmpOut = path.join(os.tmpdir(), `eval-ai-${Date.now()}.json`);
  try {
    const env = { ...process.env };
    delete env.GEMINI_API_KEY;
    delete env.DEEPSEEK_API_KEY;
    delete env.OPENAI_API_KEY;
    await execFileAsync(process.execPath, ['scripts/eval-ai-repair.mjs', '--json', tmpOut], { env, timeout: 15_000 });
    const json = JSON.parse(await fs.readFile(tmpOut, 'utf8'));
    assert.equal(json.status, 'NOT_TESTED');
    assert.equal(json.cases.length, 3);
    assert.ok(json.cases.every((c) => c.status === 'NOT_TESTED'));
  } finally {
    await fs.rm(tmpOut, { force: true }).catch(() => {});
  }
});
