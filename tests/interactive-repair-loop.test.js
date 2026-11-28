import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { buildAcceptancePlan, evaluateAcceptance, buildOptimalAlternatives } from '../src/jobs/acceptance.js';
import { runPlaywrightE2E, existingChromiumPath } from '../src/testing/playwright.js';
import { loadConfig } from '../src/config/index.js';
import { createLogger } from '../src/utils/logger.js';
import { openDb } from '../src/storage/db.js';
import { ProjectManager } from '../src/projects/manager.js';
import { SnapshotStore } from '../src/projects/snapshots.js';
import { JobQueue } from '../src/jobs/queue.js';
import { BuildRunner } from '../src/docker/runner.js';
import { Sandbox } from '../src/sandbox/native.js';
import { registerPipeline } from '../src/jobs/pipeline.js';

function brokenGameHtml() {
  return `<!doctype html>
<html lang="vi">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mini Arcade</title></head>
<body>
  <main>
    <h1>Mini Arcade</h1>
    <p id="status">Sẵn sàng — nhấn Chơi ngay</p>
    <button id="playBtn" type="button">Chơi ngay</button>
    <canvas id="board" width="240" height="160"></canvas>
  </main>
  <script>
    document.getElementById('playBtn').addEventListener('click', function () {
      // Intentional bug: calls undefined helper and never starts canvas/state
      try {
        if (window.__throwBug) missingStartFn();
      } catch (e) {
        setTimeout(() => { throw e; }, 0);
      }
    });
  </script>
</body>
</html>`;
}

function fixedGameHtml() {
  return `<!doctype html>
<html lang="vi">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mini Arcade</title></head>
<body style="min-height:1400px;margin:0;padding:16px">
  <main>
    <h1>Mini Arcade</h1>
    <p id="status">Sẵn sàng — nhấn Chơi ngay</p>
    <button id="playBtn" type="button">Chơi ngay</button>
    <canvas id="board" width="240" height="160"></canvas>
  </main>
  <script>
    const statusEl = document.getElementById('status');
    const canvas = document.getElementById('board');
    const ctx = canvas.getContext('2d');
    let x = 20;
    function draw() {
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#22c55e';
      ctx.fillRect(x, 60, 32, 32);
    }
    document.getElementById('playBtn').addEventListener('click', () => {
      statusEl.textContent = 'Đang chơi · Điểm: 10';
      x += 24;
      draw();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.code === 'Space') {
        x += 18;
        statusEl.textContent = 'Đang chơi · Di chuyển ' + x;
        draw();
      }
    });
  </script>
</body>
</html>`;
}

function miniAppPackageJson() {
  return JSON.stringify({
    name: 'mini-arcade-test',
    version: '1.0.0',
    type: 'module',
    scripts: {
      start: 'node server.js',
      test: 'node test.js',
    },
  }, null, 2);
}

function miniAppServerJs() {
  return `import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const dir = path.dirname(new URL(import.meta.url).pathname);

const server = http.createServer(async (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  const html = await fs.readFile(path.join(dir, 'public/index.html'), 'utf8');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});

server.listen(port, host, () => {
  console.log('listening on ' + host + ':' + port);
});
`;
}

test('acceptance plan and evaluation work strictly for EN and VI interactive bug reports', async () => {
  const planVi = buildAcceptancePlan({
    feedback: 'game này chưa chạy được, tôi không thể bấm nút Chơi ngay để bắt đầu chơi',
    language: 'Vietnamese',
  });
  assert.equal(planVi.strictInteraction, true);
  assert.ok(planVi.criteria.some((c) => c.id === 'interactive_start'));
  assert.ok(planVi.verificationActions.some((a) => a.kind === 'click' && a.targets.includes('chơi ngay')));

  const deadFail = evaluateAcceptance({
    plan: planVi,
    runtime: { status: 'passed', health: true },
    e2e: {
      status: 'passed',
      evidence: {
        browserAvailable: true,
        pageErrors: [],
        consoleErrors: [],
        failedRequests: [],
        domChanged: false,
        canvasChanged: false,
        urlChanged: false,
        inputAccepted: false,
        actionResults: [{ kind: 'click', target: 'Chơi ngay', performed: true, changed: false }],
        initialMetrics: { bodyTextLen: 42, canvasCount: 1, interactiveCount: 1, horizontalOverflow: 0 },
        afterMetrics: { bodyTextLen: 42, canvasCount: 1, interactiveCount: 1, horizontalOverflow: 0 },
      },
    },
    language: 'Vietnamese',
  });
  assert.equal(deadFail.passed, false);
  assert.ok(deadFail.failedCriteria.some((c) => c.id === 'interactive_start'));

  const alts = await buildOptimalAlternatives({
    feedback: 'không bấm chơi ngay được',
    evaluation: deadFail,
    attempts: 3,
    language: 'Vietnamese',
  });
  assert.ok(alts.items.length >= 2);
  assert.match(alts.summary, /tiêu chí nghiệm thu/i);
});

test('real headless Chromium verifies broken vs fixed interactive game and captures screenshots', async (t) => {
  if (!(await existingChromiumPath())) {
    t.skip('Headless Chromium not installed in this container');
    return;
  }
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-live-'));
  let html = brokenGameHtml();
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/`;

  try {
    const plan = buildAcceptancePlan({ feedback: 'game không bấm Chơi ngay được', language: 'Vietnamese' });
    const shotBefore = path.join(tmpDir, 'before.png');
    const shotAfter = path.join(tmpDir, 'after.png');

    // 1) Broken game: clicking "Chơi ngay" produces ZERO DOM/canvas change -> must FAIL!
    const brokenRes = await runPlaywrightE2E({
      uiUrl: url,
      screenshotPath: shotBefore,
      afterScreenshotPath: shotAfter,
      verificationActions: plan.verificationActions,
      strictInteraction: plan.strictInteraction,
      captureImages: true,
    });
    assert.equal(brokenRes.status, 'failed');
    assert.equal(brokenRes.evidence.domChanged, false);
    assert.equal(brokenRes.evidence.canvasChanged, false);
    assert.ok(brokenRes.evidence.afterDataUrl?.startsWith('data:image/png;base64,'));
    const statAfter = await fs.stat(shotAfter);
    assert.ok(statAfter.size > 500);

    // 2) Fixed game: clicking "Chơi ngay" + ArrowRight updates DOM + canvas -> must PASS!
    html = fixedGameHtml();
    const fixedRes = await runPlaywrightE2E({
      uiUrl: url,
      screenshotPath: shotBefore,
      afterScreenshotPath: shotAfter,
      verificationActions: plan.verificationActions,
      strictInteraction: plan.strictInteraction,
      captureImages: true,
    });
    assert.equal(fixedRes.status, 'passed');
    assert.equal(fixedRes.evidence.domChanged || fixedRes.evidence.canvasChanged, true);
    assert.equal(fixedRes.evidence.pageErrors.length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('improve closed-loop passes live screenshot+evidence on failure and succeeds on fix, or rolls back with alternatives when exhausted', async (t) => {
  if (!(await existingChromiumPath())) {
    t.skip('Headless Chromium not installed in this container');
    return;
  }

  async function setupProjectAndPipeline({ scriptMode }) {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), `loop-e2e-${scriptMode}-`));
    process.env.DATA_DIR = path.join(tmpRoot, 'data');
    process.env.WORKSPACE_DIR = path.join(tmpRoot, 'workspace');
    process.env.PROJECTS_DIR = path.join(tmpRoot, 'projects');
    process.env.IMPROVE_MAX_CORRECTIONS = '2';

    const cfg = loadConfig();
    cfg.dataDir = path.join(tmpRoot, 'data');
    cfg.workspaceDir = path.join(tmpRoot, 'workspace');
    cfg.projectsDir = path.join(tmpRoot, 'projects');
    cfg.limits.sandboxTimeoutSec = 15;
    cfg.ai.geminiKey = 'test-key';
    const log = createLogger('error');
    const db = openDb(cfg.dataDir);
    const snapshots = new SnapshotStore({ cfg, db, log });
    const projects = new ProjectManager({ cfg, db, log, snapshots });
    const jobs = new JobQueue({ db, log });
    const runner = new BuildRunner({ cfg, log });
    const sandbox = new Sandbox({ runner });

    const aiCalls = [];
    const ai = {
      status: () => ({ configured: true, gemini: true, deepseek: false }),
      async completeJson({ task, prompt, images = [] }) {
        aiCalls.push({ task, prompt, imageCount: images.length, hasPng: images.some((i) => String(i?.dataUrl || i || '').startsWith('data:image/png;base64,')) });
        if (task === 'USER_CHAT') {
          return {
            provider: 'mock-gemini',
            model: 'gemini-2.5-flash',
            json: {
              summary: 'Đã thử chạy trên trình duyệt thật nhưng nút Chơi ngay vẫn chưa đổi trạng thái.',
              alternatives: [
                {
                  title: 'Viết lại sạch hàm startGame và vòng lặp canvas',
                  description: 'Tách riêng hàm khởi tạo game và gán trực tiếp sự kiện click vào nút #playBtn.',
                  suggestedPrompt: 'Viết lại sạch script khởi chạy game cho nút #playBtn',
                },
                {
                  title: 'Kiểm tra từng bước từ nút Chơi ngay',
                  description: 'Thu gọn chỉ sửa chức năng bắt đầu chơi trước khi thêm hiệu ứng khác.',
                  suggestedPrompt: 'Chỉ sửa nút #playBtn để bắt đầu vẽ lên canvas',
                },
              ],
            },
          };
        }
        // Only patch calls happen for improve
        const patchIndex = aiCalls.filter((c) => c.task !== 'USER_CHAT').length;
        if (scriptMode === 'fix_on_second_try' && patchIndex >= 2) {
          return {
            provider: 'mock-gemini',
            model: 'gemini-2.5-flash',
            json: {
              root_cause: 'Missing click state update and canvas draw in #playBtn handler',
              risk: 'low',
              explanation: 'Đã sửa nút Chơi ngay để bắt đầu game và vẽ lên canvas.',
              files: [{ path: 'public/index.html', content: fixedGameHtml() }],
            },
          };
        }
        // Still broken patch
        return {
          provider: 'mock-gemini',
          model: 'gemini-2.5-flash',
          json: {
            root_cause: 'Attempted minor comment change only',
            risk: 'low',
            explanation: 'Updated handler script.',
            files: [{ path: 'public/index.html', content: brokenGameHtml().replace('Mini Arcade', `Mini Arcade v${patchIndex}`) }],
          },
        };
      },
    };

    registerPipeline({
      cfg, db, log, ai, projects, snapshots, jobs,
      github: { configured: () => false },
      releases: {},
      runner,
      sandbox,
    });

    const project = await projects.create({ name: 'Mini Arcade', idea: 'Mini arcade game with canvas and Play button' });
    const src = projects.sourceDir(project.slug);
    await fs.mkdir(path.join(src, 'public'), { recursive: true });
    await fs.writeFile(path.join(src, 'package.json'), miniAppPackageJson());
    await fs.writeFile(path.join(src, 'server.js'), miniAppServerJs());
    await fs.writeFile(path.join(src, 'test.js'), "console.log('mini-arcade ok');\n");
    await fs.writeFile(path.join(src, 'Dockerfile'), 'FROM node:22-alpine\nEXPOSE 8080\nCMD ["npm","start"]\n');
    await fs.writeFile(path.join(src, 'README.md'), '# Mini Arcade\n');
    await fs.writeFile(path.join(src, '.env.example'), 'PORT=8080\n');
    await fs.writeFile(path.join(src, 'public/index.html'), brokenGameHtml());

    return {
      tmpRoot, db, projects, jobs, runner, project, aiCalls,
      async cleanup() {
        await runner.stopApp({ projectSlug: project.slug }).catch(() => {});
        try { db.close(); } catch {}
        await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
      },
    };
  }

  // Case A: Fails on attempt 1 (real Chromium sees dead button + takes screenshot), passes on attempt 2!
  const caseA = await setupProjectAndPipeline({ scriptMode: 'fix_on_second_try' });
  try {
    const job = caseA.jobs.enqueue({
      type: 'improve',
      projectId: caseA.project.id,
      payload: {
        projectId: caseA.project.id,
        feedback: 'game này chưa chạy được, tôi không thể bấm và bắt đầu chơi',
      },
    });
    await caseA.jobs.kick(job);
    const finished = caseA.jobs.get(job.id);
    assert.equal(finished.status, 'done', `Unexpected failure: ${finished.error}`);
    assert.equal(finished.result.outcome, 'done');
    assert.equal(finished.result.acceptance?.passed, true);
    assert.ok(finished.result.attempts >= 2);
    // Verify AI retry actually received real Chromium failure evidence + PNG screenshot
    const patchCalls = caseA.aiCalls.filter((c) => c.task !== 'USER_CHAT');
    assert.ok(patchCalls.length >= 2);
    assert.equal(patchCalls[1].hasPng, true);
    assert.match(patchCalls[1].prompt, /neither DOM nor canvas changed state|FAILED ACCEPTANCE CRITERIA/i);
  } finally {
    await caseA.cleanup();
  }

  // Case B: Exhausts retries -> clean rollback + optimal alternatives in Vietnamese!
  const caseB = await setupProjectAndPipeline({ scriptMode: 'always_broken' });
  try {
    const job = caseB.jobs.enqueue({
      type: 'improve',
      projectId: caseB.project.id,
      payload: {
        projectId: caseB.project.id,
        feedback: 'game này chưa chạy được, tôi không thể bấm và bắt đầu chơi',
      },
    });
    await caseB.jobs.kick(job);
    const finished = caseB.jobs.get(job.id);
    assert.equal(finished.status, 'done', `Unexpected failure: ${finished.error}`);
    assert.equal(finished.result.outcome, 'rolled_back');
    assert.equal(finished.result.acceptance?.passed, false);
    assert.ok((finished.result.alternatives?.items || []).length >= 2);
    // Original broken index.html should be cleanly restored (no leftover "v2"/"v3" from failed patches)
    const currentHtml = await fs.readFile(path.join(caseB.projects.sourceDir(caseB.project.slug), 'public/index.html'), 'utf8');
    assert.doesNotMatch(currentHtml, /Mini Arcade v\d/);
  } finally {
    await caseB.cleanup();
  }
});
