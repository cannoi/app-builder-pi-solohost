import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeGithubWorkflow } from '../src/projects/generator.js';
import { GitHubManager } from '../src/github/manager.js';
import { DeepSeekProvider, normalizeDeepSeekModel } from '../src/ai/providers/deepseek.js';
import { classifyLogs } from '../src/scripts/ops.js';

test('GitHub workflow smoke test probes common web ports and pushes the tested image', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-workflow-'));
  await writeGithubWorkflow(dir, { version: '1.4.26' });
  const yml = await fs.readFile(path.join(dir, '.github/workflows/docker.yml'), 'utf8');
  assert.match(yml, /docker image inspect/);
  assert.match(yml, /COMMON=\(3000 3001 4173 5000 5173 6080 8000 8080 8081 8501\)/);
  assert.match(yml, /Smoke test passed on container port/);
  assert.match(yml, /Smoke-testing the image with its declared default runtime user/);
  assert.doesNotMatch(yml, /docker run[^\n]*--user 0/);
  assert.match(yml, /docker image push/);
  assert.doesNotMatch(yml, /name: Push image[\s\S]*push:\s*true/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('GitHub workflow lookup is tied to the published commit SHA', async () => {
  const manager = new GitHubManager({ cfg: { github: { owner: 'cannoi', token: 'x' } }, log: { warn() {} } });
  let seen = '';
  manager.api = async (_method, pathname) => {
    seen = pathname;
    return { workflow_runs: [{ id: 77, status: 'completed', conclusion: 'success', head_sha: 'abc123', html_url: 'https://github.com/example/run' }] };
  };
  const result = await manager.latestWorkflowRun('repo', 'docker.yml', { headSha: 'abc123' });
  assert.equal(result.id, 77);
  assert.equal(result.head_sha, 'abc123');
  assert.match(seen, /head_sha=abc123/);
});

test('DeepSeek legacy model selections are normalized to a current model', () => {
  const provider = new DeepSeekProvider({ apiKey: 'x', model: 'deepseek-chat' });
  assert.equal(provider.model, 'deepseek-v4-flash');
  const legacy = new DeepSeekProvider({ apiKey: 'x', model: 'deepseek-reasoner' });
  assert.equal(legacy.model, 'deepseek-v4-flash');
});

test('GitHub Actions port smoke failures are classified before changing app source', () => {
  const result = classifyLogs('Container did not become reachable within 60 seconds.\nBrick Game Console Breakout Mode running on port 3000\nError: Process completed with exit code 1.');
  assert.equal(result.code, 'workflow_port_mismatch');
  assert.match(result.hint, /Do not change the app/i);
});



test('runtime EACCES is classified before generic GitHub smoke handling', () => {
  const result = classifyLogs("container did not become reachable within 60 seconds\nError: EACCES: permission denied, mkdir '/app/data'");
  assert.equal(result.code, 'runtime_filesystem_permission');
  assert.match(result.title, /permission denied/i);
  assert.match(result.hint, /Dockerfile USER\/WORKDIR/i);
});
test('generic smoke/container failures do not trigger an unrelated workflow rewrite', async () => {
  const text = await fs.readFile(new URL('../src/jobs/pipeline.js', import.meta.url), 'utf8');
  const marker = 'const workflowSmokeRepairEligible =';
  const start = text.indexOf(marker);
  assert.ok(start >= 0);
  const block = text.slice(start, start + 420);
  assert.match(block, /workflow_port_mismatch/);
  assert.match(block, /workflow_smoke_timeout/);
  assert.match(block, /workflow_image_tag_mismatch/);
  assert.doesNotMatch(block, /smokeBroken/);
});
test('release flow never creates the SoloHost package before the GHCR image gate', async () => {
  const text = await fs.readFile(new URL('../src/jobs/pipeline.js', import.meta.url), 'utf8');
  const gate = text.indexOf('const imageOk = Boolean(imageVerification.ok);');
  const packageLine = text.indexOf('const packageInfo = await releases.prepareSoloHost');
  assert.ok(gate >= 0 && packageLine > gate);
  assert.match(text, /status: 'waiting_github_actions'/);
  assert.match(text, /workflowDiagnostics/);
  assert.match(text, /repairGithubActionsFailure/);
});

test('GHCR image gate checks the matching Actions run before accepting a tag', async () => {
  const text = await fs.readFile(new URL('../src/jobs/pipeline.js', import.meta.url), 'utf8');
  const waitStart = text.indexOf('async function waitForGithubImage');
  const workflowLookup = text.indexOf("workflowRun = await github.latestWorkflowRun(repo, 'docker.yml', { headSha })", waitStart);
  const imageCheck = text.indexOf('imageVerification = await github.verifyContainerImage', waitStart);
  assert.ok(workflowLookup >= 0 && imageCheck > workflowLookup);
  assert.ok(text.slice(waitStart, waitStart + 6000).includes("workflowRun?.status === 'completed' && workflowRun.conclusion === 'success' && imageVerification.ok"));
});

test('settings UI has no manual Podman input and guide export can request the SoloHost kit', async () => {
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const js = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /id="setPodman"/);
  assert.match(html, /settingsGrid/);
  assert.match(js, /extraPayload\.kind \|\| 'project'/);
  assert.match(js, /quick\(guide\.action, guide\.payload \|\| \{\}\)/);
});

test('DeepSeek model normalization migrates old and invalid UI aliases safely', () => {
  assert.equal(normalizeDeepSeekModel('deepseek-chat'), 'deepseek-v4-flash');
  assert.equal(normalizeDeepSeekModel('deepseek-reasoner'), 'deepseek-v4-flash');
  assert.equal(normalizeDeepSeekModel('deepseek-flash'), 'deepseek-v4-flash');
  assert.equal(normalizeDeepSeekModel('deepseek-v4-pro'), 'deepseek-v4-pro');
});


test('published runtime incidents are triaged before AI and can carry GitHub Actions evidence', async () => {
  const text = await fs.readFile(new URL('../src/jobs/pipeline.js', import.meta.url), 'utf8');
  assert.match(text, /async function collectPublishedIncidentEvidence/);
  assert.match(text, /PUBLISHED RUNTIME INCIDENT EVIDENCE/);
  assert.match(text, /const incident = await triagePublishedIncident\(project, message, runtimeNow, emit\)/);
  assert.match(text, /Skipping AI: deterministic repair is being verified/);
});

test('published incident repair republish targets the verified existing repository without asking to create another repo', async () => {
  const text = await fs.readFile(new URL('../src/jobs/pipeline.js', import.meta.url), 'utf8');
  assert.match(text, /autoRepairRelease = Boolean\(incident\?\.handled && incident\?\.evidence\?\.published/);
  assert.match(text, /existingAction: autoRepairRelease \? 'overwrite' : 'confirm'/);
  assert.match(text, /repoName: autoRepairRelease \? incident\.evidence\.repoInfo\.repo : undefined/);
});

test('work-plan Publish is not marked done unless a verified release state is returned', async () => {
  const text = await fs.readFile(new URL('../src/jobs/pipeline.js', import.meta.url), 'utf8');
  assert.match(text, /publishStatus = String\(payload\.result\?\.status/);
  assert.match(text, /!\['released', 'packaged'\]\.includes\(publishStatus\)/);
});
