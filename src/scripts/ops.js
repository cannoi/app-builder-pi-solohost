import fs from 'node:fs/promises';
import path from 'node:path';
import { listFiles } from '../utils/fsx.js';

export function parseGithubRepoUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const compact = raw.replace(/\.git$/i, '');
  const full = compact.match(/^https?:\/\/(?:www\.)?github\.com\/([^/\s#?]+)\/([^/\s#?]+)\/?$/i);
  if (full) return { owner: full[1], repo: full[2], url: `https://github.com/${full[1]}/${full[2]}` };
  const short = compact.match(/^([^/\s#?]+)\/([^/\s#?]+)$/);
  if (short && !short[1].includes('.') && short[1] !== 'http' && short[1] !== 'https') {
    return { owner: short[1], repo: short[2], url: `https://github.com/${short[1]}/${short[2]}` };
  }
  return null;
}

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

export function extractGhcrImage(text = '') {
  const m = String(text || '').match(/ghcr\.io\/[a-z0-9._-]+\/[a-z0-9._-]+(?::[a-z0-9._-]+)?/i);
  if (!m) return '';
  const raw = m[0].toLowerCase();
  return raw.includes(':') ? raw : `${raw}:latest`;
}

export function guessSoloHostPorts(text = '', image = '') {
  const blob = `${text} ${image}`.toLowerCase();
  const named = blob.match(/\b(\d{2,5})\s*:\s*(\d{2,5})\b/);
  if (named) return { hostPort: Number(named[1]), containerPort: Number(named[2]) };
  if (/vnc|novnc|browser-native|6080/.test(blob)) return { hostPort: 16080, containerPort: 6080 };
  return { hostPort: 18080, containerPort: 8080 };
}

export function classifyFailureLayer(message = '') {
  const m = String(message || '').toLowerCase();
  const wantsCode = /\b(sửa code|sua code|fix the code|rewrite|thay code|patch the app)\b/i.test(m);
  if (/solohost|cài trên pi|cai tren pi|pi desktop/.test(m) && /(không chạy|khong chay|not start|không mở|khong mo|fail|lỗi|loi|error|install)/i.test(m)) {
    return { layer: 'SOLOHOST', codeChange: wantsCode, ask: 'When does it fail? Install, Start, container exits, or the page is blank after start?' };
  }
  if (/(github actions|workflow|ghcr|upload github|package visibility|write:packages)/i.test(m)) {
    return { layer: 'GITHUB', codeChange: wantsCode, ask: 'Did source upload succeed, or did GitHub Actions / GHCR fail?' };
  }
  if (/(docker-compose|config_options|compose file|unsupported field)/i.test(m) && /(invalid|reject|error|lỗi|loi)/i.test(m)) {
    return { layer: 'DOCKER', codeChange: false, ask: 'Is SoloHost rejecting docker-compose.yml or the container itself?' };
  }
  if (/(preview|sandbox|fetch failed|err_empty|err_connection)/i.test(m) && !wantsCode) {
    return { layer: 'PREVIEW', codeChange: false, ask: 'Does Sandbox Benchmark pass? If Sandbox fails, do not change app code yet.' };
  }
  if (/(internet|offline|dns|network|không có mạng|khong co mang)/i.test(m)) {
    return { layer: 'NETWORK', codeChange: false, ask: 'Does the page load locally but fail only when calling the internet?' };
  }
  if (wantsCode || /(app\.listen|cannot find module|express|crash before listen|white screen in the app page)/i.test(m)) {
    return { layer: 'GENERATED_APP', codeChange: true, ask: '' };
  }
  if (/\b(lỗi|loi|error|failed|failure|không chạy|khong chay|không hoạt động|khong hoat dong|does not work|doesn't work|broken)\b/.test(m)) {
    return { layer: 'UNKNOWN', codeChange: false, ask: 'Where did it fail: Build, Preview, GitHub, GHCR, or SoloHost?' };
  }
  return { layer: '', codeChange: null, ask: '' };
}

export function formatLayerDiagnosis({ layer, message = '', crash = null, next = '' } = {}) {
  const where = layer || 'UNKNOWN';
  const cause = crash?.title || 'Need one more check before changing code.';
  const test = crash?.hint || 'Inspect logs and configuration first.';
  return [
    `🔎 Problem: ${String(message || cause).replace(/\s+/g, ' ').slice(0, 180)}`,
    `📍 Where: ${where}`,
    `🧩 Likely cause: ${cause}`,
    `🧪 Test: ${test}`,
    `🔒 Code changes: ${where === 'GENERATED_APP' ? 'Required only after evidence' : 'None yet'}`,
    `➡️ Next: ${next || 'Do not rewrite the app. Confirm the failing step, then I will apply the smallest safe fix.'}`,
  ].join('\n');
}

export function inferAction(message) {
  const m = String(message || '').toLowerCase();
  if (extractGhcrImage(m) && /(solohost|cài đặt|cai dat|install kit|docker-compose|config_options|file cài|tạo file|tao file|generate)/i.test(m)) return 'export';
  if (/release blocked|latest saved verification|failed runtime test|tests failed\. tap improve/i.test(m)) return 'run';
  // Explicit targeted change / create must not be trapped in diagnosis.
  if (/\b(implement this|add this feature|modify this behavior|change the code|update the application|thêm tính năng|sửa hàm|đổi hành vi)\b/.test(m)
      && !/\b(github actions|ghcr|solohost|preview|sandbox)\b/.test(m)) return 'improve';
  if (/\b(tạo app mới|build a new app|create a new app)\b/.test(m)) return 'build';
  const layer = classifyFailureLayer(m);
  if (['SOLOHOST', 'GITHUB', 'PREVIEW', 'DOCKER', 'NETWORK'].includes(layer.layer)) return 'analyze';
  if (layer.layer === 'GENERATED_APP') return 'improve';
  if (layer.layer === 'UNKNOWN' && layer.codeChange === false && !/\b(bảo mật|security)\b/.test(m)) return 'analyze';
  if (/(tổng hợp|liệt kê|summary|summarize|list)[\s\S]*(lỗi|error|issue|problem|failure|warning|security)|(lỗi|error|issue|problem|failure)[\s\S]*(tổng hợp|liệt kê|summary|summarize|list)|(diagnose|diagnosis|kiểm tra toàn bộ|check all)/i.test(m)) return 'analyze';
  if (isQuestion(m)) return 'reply';
  if (/\b(chỉnh sửa|sửa đổi|thay đổi|edit|change|modify|update|customize|customise)\b/.test(m)) return 'improve';
  if (/\b(lỗi|sự cố|vấn đề|error|failed|failure|unauthorized|forbidden|permission|cannot start|couldn't start|doesn't work|not working|broken|problem|issue|crash|không chạy được|không hoạt động|bị lỗi)\b/.test(m)) return 'improve';
  if ((/github|ghcr/.test(m) && /xuất|đăng|publish|release|push|upload/.test(m)) || (/solo\s*host/.test(m) && /xuất bản|publish|release|đăng/.test(m))) return 'publish';
  if (/\b(zip|download|tải về|xuất file|export zip|file cài đặt|install kit)\b/.test(m)) return 'export';
  if (/\b(chạy app|run the app|preview|test link|mở app|cho tôi link)\b/.test(m)) return 'run';
  if (/\b(sửa lỗi|hãy sửa|fix (it|the)|crash|không chạy được|không hoạt động|bị lỗi|lỗi|sự cố|vấn đề|error|failed|failure|unauthorized|forbidden|permission|cannot start|couldn't start|doesn't work|not working|broken|registry|pull image)\b/.test(m)) return 'improve';
  if (/\b(security|bảo mật|quét bảo mật|security scan|fix security|sửa bảo mật|unsafe|vulnerability)\b/.test(m)) return /\b(fix|sửa|repair|remove|khắc phục)\b/.test(m) ? 'improve' : 'analyze';
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
  if (/EACCES|permission denied/i.test(t) && /(?:mkdir|open|write|rename|unlink)/i.test(t)) {
    const target = t.match(/(?:mkdir|open|write|rename|unlink)[^'\"]*['\"]([^'\"]+)['\"]/i)?.[1] || '';
    return { code: 'runtime_filesystem_permission', title: `Runtime filesystem permission denied${target ? ` at ${target}` : ''}.`, hint: 'The container user cannot write the required runtime path. Inspect the Dockerfile USER/WORKDIR and patch only the concrete writable directory; do not chmod the whole image.' };
  }
  if (/container did not become reachable/i.test(t) && /running on port\s+(\d+)/i.test(t)) {
    const port = t.match(/running on port\s+(\d+)/i)?.[1] || 'the app port';
    return { code: 'workflow_port_mismatch', title: `The GitHub smoke test did not reach the app port (${port}).`, hint: `The app reports port ${port}. The old smoke test can miss valid ports; regenerate the Builder workflow and retry. Do not change the app just to satisfy a wrong CI port.` };
  }
  if (/container did not become reachable/i.test(t)) return { code: 'workflow_smoke_timeout', title: 'GitHub built the image, but its smoke test could not reach the web service.', hint: 'Check the failed Actions log for the app listening port, startup error, or health route. Fix only the confirmed cause, then rebuild the image.' };
  if (/eaddrinuse/i.test(t)) return { code: 'port_busy', title: 'Port is already in use.', hint: 'Stop the previous preview and Run again.' };
  if (/syntaxerror|unexpected token/i.test(t)) return { code: 'syntax', title: 'The server file has a syntax error.', hint: 'I will patch the file and Run again.' };
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|dns|name resolution/i.test(t)) {
    return { code: 'network_dns', title: 'DNS resolution failed.', hint: 'First verify Sandbox Internet/DNS. Do not rewrite the app proxy until the sandbox network test passes.' };
  }
  if (/ETIMEDOUT|ECONNRESET|ENETUNREACH|EHOSTUNREACH|network is unreachable|socket hang up/i.test(t)) {
    return { code: 'network_transport', title: 'Outbound network connection failed.', hint: 'Run Sandbox Benchmark → Internet Test first. If Sandbox Internet fails, fix the environment; if it passes, inspect the app gateway/proxy and target URL.' };
  }
  if (/fetch failed|econnrefused|couldn't connect|preview port is not open/i.test(t)) {
    return { code: 'preview_connection', title: 'Preview could not open the test page.', hint: 'Separate app runtime from network failure: verify Sandbox Internet first, then inspect the app gateway/proxy.' };
  }
  return null;
}

export function describeFailure({ error = '', logs = '', findings = [], action = '' } = {}) {
  const raw = String(error || logs || '').trim();
  const crash = classifyLogs(`${error}\n${logs}`);
  const evidence = raw.split('\n').filter(Boolean).slice(0, 8).join('\n').slice(0, 900);
  const findingText = (findings || []).map((f) => f.title || f.detail || f.check).filter(Boolean).slice(0, 5);
  const what = crash?.title || (raw ? raw.split('\n')[0].slice(0, 180) : 'The last action did not finish cleanly.');
  const security = (findings || []).find((f) => f.fix || f.rootCause);
  const why = crash?.hint || security?.rootCause || findingText[0] || 'The preview, build, or file check returned an error.';
  const fix = crash?.hint || security?.fix || (action === 'run' ? 'Run the app again after the files exist. If it still fails, send the COPY_FOR_AI block below.' : 'Apply the smallest targeted patch to the affected file. Do not rewrite the app.');
  const copy = [
    'APP BUILDER ERROR REPORT',
    `WHAT: ${what}`,
    `WHY: ${why}`,
    findingText.length ? `CHECKS: ${findingText.join(' | ')}` : '',
    evidence ? `EVIDENCE:\n${evidence}` : '',
    `FIX: ${fix}`,
    'CONSTRAINT: Preserve existing working files. Change only the files needed for this error.',
  ].filter(Boolean).join('\n');
  return { code: crash?.code || 'unknown', what, why, fix, evidence, copy };
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
