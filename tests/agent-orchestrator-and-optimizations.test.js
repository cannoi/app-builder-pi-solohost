import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  AgentOrchestrator,
  createBugFixPlan,
  startOrchestratorStep,
  completeOrchestratorStep,
  failOrchestratorStep,
  finalizeOrchestratorPlan,
  formatPlanChecklistText,
} from '../src/agent/orchestrator.js';
import { NativePreview } from '../src/runtime/native-preview.js';
import { runNodeTests } from '../src/testing/engine.js';
import { evaluateProductDepth } from '../src/jobs/product-checklist.js';
import { loadConfig } from '../src/config/index.js';
import { createLogger } from '../src/utils/logger.js';
import { openDb } from '../src/storage/db.js';
import { ProjectManager } from '../src/projects/manager.js';
import { SnapshotStore } from '../src/projects/snapshots.js';
import { JobQueue } from '../src/jobs/queue.js';
import { registerRoutes } from '../src/api/routes.js';
import { createApp, listen } from '../src/http.js';

async function copyFixtureProject(srcDir, dstDir) {
  await fs.mkdir(dstDir, { recursive: true });
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(srcDir, entry.name);
    const dst = path.join(dstDir, entry.name);
    if (entry.name === 'node_modules') {
      await fs.symlink(src, dst, 'dir');
    } else if (entry.isDirectory()) {
      await fs.cp(src, dst, { recursive: true });
    } else {
      await fs.copyFile(src, dst);
    }
  }
}

test('AgentOrchestrator generates contextual EN/VI checklists and tracks step transitions', async () => {
  const viPlan = await createBugFixPlan({
    jobId: 'job-vi-1',
    project: { id: 'p-1', name: 'Mini Game' },
    feedback: 'Nút bấm Bắt đầu chơi không chạy được trên điện thoại',
    language: 'Vietnamese',
    runtime: { error: 'TypeError: startGame is not defined' },
  });

  assert.equal(viPlan.locale, 'vi');
  assert.equal(viPlan.status, 'running');
  assert.ok(viPlan.steps.length >= 6);
  assert.equal(viPlan.doneCount, 0);
  assert.match(viPlan.steps[0].detail, /startGame is not defined/);
  assert.match(viPlan.steps.find((s) => s.key === 'apply_patch').title, /nút bấm|điều khiển/i);

  startOrchestratorStep(viPlan, 'reproduce_inspect', 'Đọc script.js');
  assert.equal(viPlan.runningStep, 'reproduce_inspect');
  completeOrchestratorStep(viPlan, 'reproduce_inspect', 'Tìm thấy lỗi tên hàm');
  startOrchestratorStep(viPlan, 'acceptance_criteria');
  completeOrchestratorStep(viPlan, 'apply_patch');
  failOrchestratorStep(viPlan, 'live_browser_qa', 'Canvas chưa vẽ');
  assert.equal(viPlan.failedCount, 1);

  finalizeOrchestratorPlan(viPlan, { outcome: 'DONE', verified: true, summary: 'Đã sửa và qua E2E' });
  assert.equal(viPlan.status, 'done');
  const txt = formatPlanChecklistText(viPlan);
  assert.match(txt, /✅/);

  const enPlan = await createBugFixPlan({
    feedback: 'API POST /api/orders returns 404 in preview',
    language: 'English',
  });
  assert.equal(enPlan.locale, 'en');
  assert.match(enPlan.steps.find((s) => s.key === 'apply_patch').title, /API route/i);
});

test('Engineering Toolkit UI controls are removed and bug-plan/job/project endpoints expose orchestratorPlan', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-ui-orch-'));
  const prevCwd = process.cwd();
  const cfg = loadConfig();
  cfg.dataDir = path.join(tmp, 'data');
  cfg.projectsDir = path.join(tmp, 'projects');
  cfg.templatesDir = path.resolve(prevCwd, 'templates');
  cfg.port = 0;

  const log = createLogger('error');
  const db = openDb(cfg.dataDir);
  const snapshots = new SnapshotStore({ cfg, db, log });
  const projects = new ProjectManager({ cfg, db, log, snapshots });
  const jobs = new JobQueue({ db, log });
  const app = createApp();
  const ctx = {
    cfg,
    db,
    log,
    projects,
    snapshots,
    jobs,
    github: { configured: () => false },
    releases: { list: () => [] },
    runner: { status: () => ({ mode: 'native-preview' }), inspectContainer: async () => ({}), listContainers: async () => ({ status: 'skipped', items: [] }) },
    ai: { completeJson: async () => { throw new Error('unused'); } },
  };
  registerRoutes(app, ctx);
  const server = listen(app, {
    port: 0,
    bind: '127.0.0.1',
    publicDir: path.resolve(prevCwd, 'public'),
    log,
    cfg,
  });

  try {
    await new Promise((r) => server.once('listening', r));
    const addr = server.address();
    const base = `http://127.0.0.1:${addr.port}`;

    // Verify public/index.html removed Engineering UI items
    const htmlRes = await fetch(`${base}/`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.doesNotMatch(html, /engineering\.js|engineering\.css/);
    assert.doesNotMatch(html, /data-more="engineering"|engModeSelect|engFeatRuntime|engFeatBrowser|engFeatEvidence|engFeatRegression|engFeatRollback/);
    assert.doesNotMatch(html, /🛠 Engineering/);

    // Verify public/app.js renders live Agent Orchestrator card hooks
    const jsRes = await fetch(`${base}/app.js`);
    const appJs = await jsRes.text();
    assert.match(appJs, /renderOrchestratorCard/);
    assert.match(appJs, /orch-plan-card/);

    // Create project & generate bug-fix plan via POST /api/projects/:id/bug-plan
    const proj = await projects.create({ name: 'Game Demo', idea: 'Arcade game' });
    const planRes = await fetch(`${base}/api/projects/${proj.id}/bug-plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feedback: 'Bấm Chơi ngay không khởi động game' }),
    });
    assert.equal(planRes.status, 200);
    const planBody = await planRes.json();
    assert.equal(planBody.ok, true);
    assert.ok(planBody.plan?.steps?.length >= 6);

    // Check GET /api/projects/:id returns orchestratorPlan
    const projRes = await fetch(`${base}/api/projects/${proj.id}`);
    assert.equal(projRes.status, 200);
    const projJson = await projRes.json();
    assert.equal(projJson.orchestratorPlan?.id, planBody.plan.id);

    // Check GET /api/jobs/:id merges stored orchestratorPlan matching jobId while running
    const job = jobs.enqueue({ type: 'improve', projectId: proj.id, payload: { projectId: proj.id, feedback: 'fix bug' } });
    const orch = new AgentOrchestrator({ projects });
    const jobPlan = await orch.generatePlan({ jobId: job.id, project: proj, feedback: 'Sửa nút chơi ngay', language: 'Vietnamese' });
    await orch.start(proj, jobPlan, 'reproduce_inspect', 'Đang kiểm tra tệp HTML');

    const jobRes = await fetch(`${base}/api/jobs/${job.id}`);
    assert.equal(jobRes.status, 200);
    const jobJson = await jobRes.json();
    assert.equal(jobJson.orchestratorPlan?.id, jobPlan.id);
    assert.equal(jobJson.orchestratorPlan?.runningStep, 'reproduce_inspect');
  } finally {
    await new Promise((r) => server.close(r));
    db.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('NativePreview reverse-proxies /api/* to Node backend and captures logs', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-native-proxy-'));
  const projRoot = path.join(tmp, 'proj');
  const srcDir = path.join(projRoot, 'source');
  const pubDir = path.join(srcDir, 'public');
  await fs.mkdir(pubDir, { recursive: true });

  await fs.writeFile(path.join(srcDir, 'package.json'), JSON.stringify({
    name: 'proxy-probe-app',
    version: '1.0.0',
    type: 'module',
    scripts: { start: 'node server.js' },
  }));
  await fs.writeFile(path.join(srcDir, 'server.js'), `
    import http from 'node:http';
    const port = Number(process.env.PORT || 3000);
    const items = [{ id: 1, name: 'Trà sữa' }];
    const srv = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
      }
      if (req.url === '/api/items' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ items }));
      }
      if (req.url === '/api/items' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          const parsed = JSON.parse(body || '{}');
          items.push({ id: items.length + 1, name: parsed.name });
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, count: items.length }));
        });
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    srv.listen(port, '127.0.0.1', () => console.log('proxy-probe-backend-ready'));
  `);
  await fs.writeFile(path.join(pubDir, 'index.html'), `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Proxy Test</title></head>
<body style="min-height:900px"><main><h1>Shop</h1><div id="out">loading</div><button id="addBtn" type="button">Add</button></main>
<script>
fetch('/api/items').then(r => r.json()).then(d => { document.getElementById('out').textContent = 'Items: ' + d.items.length; });
</script></body></html>`);

  const preview = new NativePreview({ cfg: { runtime: {} }, log: createLogger('error') });
  let slug = 'proxy-probe-' + Date.now();
  try {
    const res = await preview.run({ sourcePath: srcDir, projectSlug: slug, keepRunning: true, skipInternetProbe: true });
    assert.equal(res.status, 'passed', `Expected passed, got: ${res.error}`);
    assert.equal(res.e2e?.status, 'passed', `Expected Playwright E2E passed, got: ${res.e2e?.error}`);
    assert.match(res.logs || '', /proxy-probe-backend-ready/);

    const getApi = await fetch(`${res.url}/api/items`);
    assert.equal(getApi.status, 200);
    const getData = await getApi.json();
    assert.equal(getData.items.length, 1);

    const postApi = await fetch(`${res.url}/api/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Hồng trà' }),
    });
    assert.equal(postApi.status, 201);
    const postData = await postApi.json();
    assert.equal(postData.count, 2);
  } finally {
    await preview.stop({ projectSlug: slug }).catch(() => {});
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('Real generated projects (bobashop & shop-sales-mini) pass UI quality gate, isolated runNodeTests, and NativePreview /api proxy', async (t) => {
  const bobaSrc = path.resolve(process.cwd(), 'projects/bobashop/source');
  const miniSrc = path.resolve(process.cwd(), 'projects/shop-sales-mini/source');
  if (!fssync.existsSync(bobaSrc) || !fssync.existsSync(miniSrc)) {
    t.skip('Generated fixture apps not present in projects/');
    return;
  }

  // 1. UI Quality gate no longer produces false negative on Tailwind / external CSS
  const bobaDepth = await evaluateProductDepth(bobaSrc, { idea: 'boba tea shop' });
  const miniDepth = await evaluateProductDepth(miniSrc, { idea: 'mini shop sales' });
  assert.equal(bobaDepth.ok, true, `Expected bobashop depth ok, got issues: ${JSON.stringify(bobaDepth.issues)}`);
  assert.equal(miniDepth.ok, true, `Expected shop-sales-mini depth ok, got issues: ${JSON.stringify(miniDepth.issues)}`);

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-real-fixtures-'));
  const slugs = [];
  const preview = new NativePreview({ cfg: { runtime: {} }, log: createLogger('error') });

  try {
    // 2. Copy shop-sales-mini into temp dir and test isolated runNodeTests + NativePreview API proxy
    const miniTmp = path.join(tmp, 'mini', 'source');
    await copyFixtureProject(miniSrc, miniTmp);

    const prevPortEnv = process.env.PORT;
    process.env.PORT = '3000'; // simulate Builder server PORT=3000 in parent env!
    let nodeRes;
    try {
      nodeRes = await runNodeTests(miniTmp, 60000);
    } finally {
      if (prevPortEnv === undefined) delete process.env.PORT;
      else process.env.PORT = prevPortEnv;
    }
    assert.equal(nodeRes.status, 'passed', `Expected shop-sales-mini tests to pass on isolated ephemeral PORT, got: ${nodeRes.error || nodeRes.reason}`);

    const miniSlug = 'test-mini-' + Date.now();
    slugs.push(miniSlug);
    const miniPreview = await preview.run({ sourcePath: miniTmp, projectSlug: miniSlug, keepRunning: true, skipInternetProbe: true });
    assert.equal(miniPreview.status, 'passed', `Expected shop-sales-mini preview passed, got: ${miniPreview.error}`);
    assert.equal(miniPreview.e2e?.status, 'passed', `Expected shop-sales-mini E2E passed, got: ${miniPreview.e2e?.error}`);
    const apiProducts = await fetch(`${miniPreview.url}/api/products`);
    assert.equal(apiProducts.status, 200);
    const prodJson = await apiProducts.json();
    assert.ok(Array.isArray(prodJson));

    // 3. Copy bobashop into temp dir and verify NativePreview /api/products & Playwright E2E pass
    const bobaTmp = path.join(tmp, 'boba', 'source');
    await copyFixtureProject(bobaSrc, bobaTmp);
    const bobaSlug = 'test-boba-' + Date.now();
    slugs.push(bobaSlug);
    const bobaPreview = await preview.run({ sourcePath: bobaTmp, projectSlug: bobaSlug, keepRunning: true, skipInternetProbe: true });
    assert.equal(bobaPreview.status, 'passed', `Expected bobashop preview passed, got: ${bobaPreview.error}`);
    assert.equal(bobaPreview.e2e?.status, 'passed', `Expected bobashop E2E passed, got: ${bobaPreview.e2e?.error}`);
    const bobaOrders = await fetch(`${bobaPreview.url}/api/orders`);
    assert.equal(bobaOrders.status, 200);
    const bobaJson = await bobaOrders.json();
    assert.ok(Array.isArray(bobaJson));
    const postOrder = await fetch(`${bobaPreview.url}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ name: 'Trà sữa trân châu', price: 35000, qty: 1 }], total: 35000, customerName: 'Test' }),
    });
    assert.equal(postOrder.status, 201);
    const created = await postOrder.json();
    assert.equal(created.success, true);
  } finally {
    for (const s of slugs) await preview.stop({ projectSlug: s }).catch(() => {});
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
