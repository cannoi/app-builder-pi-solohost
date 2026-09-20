import fs from 'node:fs/promises';
import path from 'node:path';
import { listFiles } from '../utils/fsx.js';

export function isQuestion(message) {
  const m = String(message || '').toLowerCase();
  return /[?]|(làm sao|như thế nào|how (do|to|can|does)|what is|where (is|do)|why |token|hướng dẫn|cách (lấy|tạo|đăng|cài)|giải thích|explain|help me understand)/i.test(m)
    && !/\b(build|sửa ngay|fix now|chạy ngay|publish now|xuất bản ngay)\b/i.test(m);
}

export function splitUserSteps(message) {
  const text = String(message || '').trim();
  if (!text) return [];
  const numbered = text.split(/\n+/).map((l) => l.replace(/^\s*(?:\d+[\.\)]\s+|[-*]\s+)/, '').trim()).filter(Boolean);
  if (numbered.length >= 2 && numbered.length <= 6) return numbered;
  const parts = text.split(/\s+(?:then|after that|sau đó|rồi|and then|và sau đó)\s+/i).map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2 && parts.length <= 5) return parts;
  return [text];
}

export function inferAction(message) {
  const m = String(message || '').toLowerCase();
  if (isQuestion(m)) return 'reply';
  if (/\b(lỗi|sự cố|vấn đề|error|failed|failure|unauthorized|forbidden|permission|cannot start|couldn't start|doesn't work|not working|broken|problem|issue|crash|không chạy được|không hoạt động|bị lỗi)\b/.test(m)) return 'improve';
  if ((/github|ghcr/.test(m) && /xuất|đăng|publish|release|push|upload/.test(m)) || (/solo\s*host/.test(m) && /xuất bản|publish|release|đăng/.test(m))) return 'publish';
  if (/\b(zip|download|tải về|xuất file|export zip|file cài đặt|install kit)\b/.test(m)) return 'export';
  if (/\b(chạy app|run the app|preview|test link|mở app|cho tôi link)\b/.test(m)) return 'run';
  if (/\b(sửa lỗi|hãy sửa|fix (it|the)|crash|không chạy được|không hoạt động|bị lỗi|lỗi|sự cố|vấn đề|error|failed|failure|unauthorized|forbidden|permission|cannot start|couldn't start|doesn't work|not working|broken|registry|pull image)\b/.test(m)) return 'improve';
  if (/\b(quét bảo mật|security scan|analyze app|inspect container)\b/.test(m)) return 'analyze';
  if (/\b(build lại|viết code|scaffold|tạo app|build the app)\b/.test(m)) return 'build';
  return null;
}

export function classifyLogs(logs = '') {
  const t = String(logs || '');
  if (/ghcr\.io\/|docker compose|registry/i.test(t) && /unauthorized|denied|forbidden|pull access denied|authentication required/i.test(t)) {
    return { code: 'registry_unauthorized', title: 'The Docker image cannot be downloaded from GHCR.', hint: 'The image is private, the repository/package is not accessible, or GitHub authentication/visibility is not ready. Check the image name and GHCR package visibility before retrying.' };
  }
  if (/github.*workflow|workflow.*permission|actions.*permission/i.test(t) && /read.?only|write|permission|403|forbidden/i.test(t)) {
    return { code: 'github_workflow_permission', title: 'GitHub Actions does not have permission to write.', hint: 'Open GitHub → repository Settings → Actions → General → Workflow permissions and select Read and write permissions, then save.' };
  }
  if (/cannot find module ['"]?express['"]?/i.test(t)) {
    return { code: 'missing_express', title: 'Server crashed before listen: express is not installed.', hint: 'Rebuild the Docker image so npm install runs inside the image.' };
  }
  if (/cannot find module ['"]([^'"]+)['"]/i.test(t)) {
    const mod = t.match(/cannot find module ['"]([^'"]+)['"]/i)[1];
    return { code: 'missing_module', title: `Server crashed before listen: missing ${mod}.`, hint: 'Add the dependency and rebuild the image.' };
  }
  if (/enoent|no such file/i.test(t) && /package\.json/i.test(t)) {
    return { code: 'missing_package', title: 'package.json was not in the workspace.', hint: 'Do not run npm in an empty sandbox. Use Build, then Run.' };
  }
  if (/eaddrinuse/i.test(t)) return { code: 'port_busy', title: 'Port is already in use.', hint: 'Stop the previous preview and Run again.' };
  if (/syntaxerror|unexpected token/i.test(t)) return { code: 'syntax', title: 'The server file has a syntax error.', hint: 'I will patch the file and Run again.' };
  if (/fetch failed|econnrefused|couldn't connect|preview port is not open/i.test(t)) {
    return { code: 'preview_connection', title: 'Preview could not open the test page.', hint: 'Check the preview process, assigned port, and server startup log. If the app calls an external API, also verify the API URL and Internet access.' };
  }
  if (/no confirmed internet|internet access|ENOTFOUND|EAI_AGAIN|network is unreachable/i.test(t)) {
    return { code: 'preview_internet', title: 'Preview has no confirmed Internet access.', hint: 'Keep Preview Online enabled and verify DNS/network access from the preview runtime before testing external APIs.' };
  }
  return null;
}

export function describeFailure({ error = '', logs = '', findings = [], action = '', files = [] } = {}) {
  const raw = String(error || logs || '').trim();
  const crash = classifyLogs(`${error}\n${logs}`);
  const evidence = raw.split('\n').filter(Boolean).slice(0, 12).join('\n').slice(0, 1800);
  const findingText = (findings || []).map((f) => f.title || f.detail || f.check).filter(Boolean).slice(0, 8);
  const what = crash?.title || (raw ? raw.split('\n')[0].slice(0, 220) : 'The last action did not finish cleanly.');
  const why = crash?.hint || findingText[0] || 'The preview, build, test, or security check returned an error.';
  const affected = files.length ? files.slice(0, 12).join(', ') : 'See EVIDENCE and the project files involved in the failing check.';
  let fix = crash?.hint;
  if (!fix && findings?.length) fix = findings.slice(0, 3).map((f) => f.fix || f.detail || 'Review this finding.').join(' ');
  if (!fix) fix = action === 'run' ? 'Inspect the startup error, patch only the affected file, then Run again.' : 'Apply the smallest patch to the affected file. Do not rewrite the app.';
  const copy = [
    'APP BUILDER ERROR REPORT v1',
    `CODE: ${crash?.code || 'unknown'}`,
    `STAGE: ${action || 'unknown'}`,
    `SYMPTOM: ${what}`,
    `LIKELY_CAUSE: ${why}`,
    `AFFECTED: ${affected}`,
    findingText.length ? `CHECKS: ${findingText.join(' | ')}` : '',
    evidence ? `EVIDENCE:\n${evidence}` : '',
    `RECOMMENDED_FIX: ${fix}`,
    'REPAIR_RULE: Diagnose first; checkpoint; change only affected files; retest; rollback if worse; never rewrite unrelated working features.',
  ].filter(Boolean).join('\n');
  return { code: crash?.code || 'unknown', what, why, fix, evidence, affected, copy };
}

export async function diagnoseSource(sourceDir) {
  const files = await listFiles(sourceDir).catch(() => []);
  const findings = [];
  if (!files.length) findings.push({ code: 'empty_source', title: 'No source files in the project.', fix: 'build' });
  const hasPkg = files.includes('package.json');
  const hasDocker = files.includes('Dockerfile');
  const hasServer = files.some((f) => /(^|\/)(server|index|app)\.(js|mjs|cjs|ts)$/.test(f));
  const hasHtml = files.some((f) => f.endsWith('.html'));
  if (!hasPkg && !hasDocker) findings.push({ code: 'no_manifest', title: 'Missing package.json and Dockerfile.', fix: 'build' });
  if (!hasServer) findings.push({ code: 'no_server', title: 'No server entry file.', fix: 'improve' });
  if (!hasHtml) findings.push({ code: 'no_ui', title: 'No HTML UI file.', fix: 'improve' });
  if (files.includes('public/index.html') && !files.includes('public/game.js')) {
    const html = await fs.readFile(path.join(sourceDir, 'public/index.html'), 'utf8').catch(() => '');
    if (/game\.js/.test(html)) findings.push({ code: 'missing_game_js', title: 'index.html loads game.js but the file is missing.', fix: 'improve' });
  }
  return { files, findings };
}

export function nextStep({ runtime, findings, action }) {
  const card = guideCard({ runtime, findings, action });
  return card.detail;
}

export function guideCard({ runtime, findings, action, publishReady = false }) {
  if (action === 'publish' && !publishReady) {
    return { step: 3, title: 'Image is missing', action: 'publish', label: '🚀 Publish', detail: 'Do not install yet. The GHCR image is not ready. Add GitHub token if needed, then tap Publish again.' };
  }
  if (action === 'publish' && publishReady) {
    return { step: 4, title: 'Install kit is ready', action: 'export', label: '⬇ Zip', detail: 'The image exists. Download the ZIP and add docker-compose.yml plus config_options.yml in SoloHost.' };
  }
  if (runtime?.status === 'passed' && runtime?.previewPath && action === 'publish') {
    return { step: 3, title: 'Publish on SoloHost', action: 'publish', label: '🚀 Publish', detail: 'The preview works. I will publish now when you tap Publish.' };
  }
  if (runtime?.status === 'passed' && runtime?.previewPath) {
    return { step: 3, title: 'Try it, then publish', action: 'publish', label: '🚀 Publish', detail: 'Open the test link. If the app feels right, tap Publish. If not, tell me what to change.' };
  }
  if (findings?.some((f) => f.code === 'empty_source' || f.code === 'no_manifest')) {
    return { step: 1, title: 'Create the app files', action: 'build', label: '✨ Build', detail: 'There is no app yet. Tap Build and I will write the files.' };
  }
  if (runtime?.status === 'failed' || findings?.length) {
    return { step: 2, title: 'Fix and run', action: 'run', label: '▶ Run', detail: 'I found a problem. Tap Run and I will fix what I can, then open a test link.' };
  }
  return { step: 2, title: 'Run a test preview', action: 'run', label: '▶ Run', detail: 'Files are ready. Tap Run to start the app and get a test link.' };
}

export function isHostDockerCommand(command) {
  return /\bdocker\b/i.test(String(command || ''));
}

export function isNpmOnEmptyRisk(command) {
  return /\bnpm\b|\byarn\b|\bpnpm\b/i.test(String(command || ''));
}
