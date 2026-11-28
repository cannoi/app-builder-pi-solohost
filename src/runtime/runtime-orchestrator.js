/**
 * Runtime Orchestrator — Preview Engine 2.0
 * Detects application type with confidence and returns a structured runtime profile
 * used by NativePreview, BuildRunner, and the Preview Verification Gate.
 *
 * Supported profiles (v1.11.0):
 *   A. STATIC WEB
 *   B. NODE.JS (Express / Fastify / Koa / plain)
 *   C. VITE FRONTEND (React / Vue / Vanilla)
 *   D. SSR / FRAMEWORK (Next / Nuxt / TanStack — limited / prefer Publish)
 *   E. CONTAINER-ONLY APPLICATION (Docker is not available in preview → honest preview_limited)
 *   F. OTHER LANGUAGES (Python / PHP / Go / Java — native when the toolchain exists)
 */

import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { CONTAINER_ONLY, reasonMessages } from './preview-messages.js';

const LOCKFILES = [
  { file: 'pnpm-lock.yaml', pm: 'pnpm' },
  { file: 'yarn.lock', pm: 'yarn' },
  { file: 'package-lock.json', pm: 'npm' },
  { file: 'npm-shrinkwrap.json', pm: 'npm' },
];

/**
 * @typedef {Object} RuntimeProfile
 * @property {string} runtime_id
 * @property {string|null} framework
 * @property {number} confidence          0–1
 * @property {string|null} startup_command
 * @property {string|null} install_command
 * @property {string|null} build_command
 * @property {string|null} output_directory
 * @property {number|null} expected_port
 * @property {string} health_check_strategy
 * @property {boolean} preview_supported
 * @property {boolean} sandbox_required
 * @property {string|null} unsupported_reason
 * @property {string} package_manager
 * @property {string[]} signals
 * @property {Object} guidance
 */

export async function detectRuntimeProfile(sourceDir) {
  const files = new Set();
  const walk = async (dir, depth = 0) => {
    if (depth > 4) return;
    const ents = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of ents) {
      if (['node_modules', '.git', 'dist', '.output', '.next', 'build', 'coverage'].includes(e.name)) continue;
      const rel = path.relative(sourceDir, path.join(dir, e.name)).replace(/\\/g, '/');
      if (e.isDirectory()) await walk(path.join(dir, e.name), depth + 1);
      else files.add(rel);
    }
  };
  try { await walk(sourceDir); } catch { /* empty */ }

  const pkgRaw = await fs.readFile(path.join(sourceDir, 'package.json'), 'utf8').catch(() => '{}');
  let pkg = {};
  try { pkg = JSON.parse(pkgRaw); } catch { pkg = {}; }
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const scripts = pkg.scripts || {};
  const dockerfile = await fs.readFile(path.join(sourceDir, 'Dockerfile'), 'utf8').catch(() => '');
  const hasCompose = files.has('docker-compose.yml') || files.has('compose.yml') || files.has('solohost/docker-compose.yml');

  // Package manager preference from lockfile
  let packageManager = 'npm';
  for (const lf of LOCKFILES) {
    if (files.has(lf.file)) { packageManager = lf.pm; break; }
  }

  const signals = [];
  const has = (re) => [...files].some((f) => re.test(f));
  const hasExact = (name) => files.has(name);

  // --- Detection signals ---
  if (deps.vite || scripts.dev?.includes('vite') || hasExact('vite.config.ts') || hasExact('vite.config.js') || hasExact('vite.config.mjs')) {
    signals.push('vite');
  }
  if (deps.react || deps['react-dom']) signals.push('react');
  if (deps.vue || deps['@vue/runtime-dom']) signals.push('vue');
  if (deps.next || hasExact('next.config.js') || hasExact('next.config.mjs') || hasExact('next.config.ts')) signals.push('next');
  if (deps.nuxt || hasExact('nuxt.config.ts') || hasExact('nuxt.config.js')) signals.push('nuxt');
  if (deps['@tanstack/react-start'] || deps['@tanstack/start'] || deps['@tanstack/react-router']) signals.push('tanstack');
  if (deps.express || deps.fastify || deps.koa || deps.hono) signals.push('node-server');
  if (scripts.start && (deps.express || deps.fastify || deps.koa || deps.hono || !deps.vite)) signals.push('node-start');
  const hasIndex = hasExact('index.html') || ['public', 'www', 'static'].some((d) => files.has(`${d}/index.html`));
  if (hasIndex && !signals.includes('vite') && !signals.includes('next')) signals.push('static-html');
  if (hasExact('index.html') && has(/\.js$/)) signals.push('static-js');
  if (dockerfile) signals.push('dockerfile');
  if (/FROM .+ AS /i.test(dockerfile) || dockerfile.includes('vite build') || dockerfile.includes('.output/')) signals.push('multi-stage-docker');
  if (hasCompose) signals.push('compose');
  if (deps.python || hasExact('requirements.txt') || hasExact('pyproject.toml') || hasExact('app.py') || hasExact('main.py')) signals.push('python');
  if (hasExact('composer.json') || hasExact('index.php')) signals.push('php');
  if (hasExact('go.mod') || hasExact('main.go')) signals.push('go');
  if (hasExact('pom.xml') || hasExact('build.gradle')) signals.push('java');

  // --- Decision tree (confidence-based, ordered by specificity) ---
  /** @type {RuntimeProfile} */
  let profile = null;

  // D. SSR / heavy frameworks — limited native support
  if (signals.includes('next') || signals.includes('nuxt') || signals.includes('tanstack')) {
    const fw = signals.includes('next') ? 'next' : signals.includes('nuxt') ? 'nuxt' : 'tanstack';
    profile = {
      runtime_id: 'ssr-framework',
      framework: fw,
      confidence: 0.92,
      startup_command: scripts.start || scripts.dev || null,
      install_command: installCmd(packageManager),
      build_command: scripts.build || null,
      output_directory: fw === 'next' ? '.next' : fw === 'nuxt' ? '.output' : 'dist',
      expected_port: 3000,
      health_check_strategy: 'http-root',
      preview_supported: false, // prefer Publish / Sandbox for true SSR
      sandbox_required: true,
      unsupported_reason: `${fw} server-side apps cannot be previewed reliably here. Use Publish to run it.`,
      reason_code: 'TOOLCHAIN_MISSING',
      package_manager: packageManager,
      signals,
      guidance: {
        en: `${fw} apps cannot be previewed reliably here. Use Publish to run it.`,
        vi: `Ứng dụng ${fw} chưa xem thử ổn định được ở đây. Hãy dùng Xuất bản để chạy.`,
      },
    };
  }
  // C. Vite frontend (React / Vue / Vanilla)
  else if (signals.includes('vite')) {
    const fw = signals.includes('react') ? 'react-vite' : signals.includes('vue') ? 'vue-vite' : 'vite';
    profile = {
      runtime_id: 'vite-frontend',
      framework: fw,
      confidence: 0.95,
      startup_command: scripts.dev || 'vite --host 127.0.0.1',
      install_command: installCmd(packageManager, true), // include devDeps
      build_command: scripts.build || 'vite build',
      output_directory: 'dist',
      expected_port: null, // allocated dynamically
      health_check_strategy: 'http-root-or-health',
      preview_supported: true,
      sandbox_required: false,
      unsupported_reason: null,
      package_manager: packageManager,
      signals,
      guidance: {
        en: `Vite (${fw}) detected. Native Preview will install deps and start the Vite dev server.`,
        vi: `Phát hiện Vite (${fw}). Native Preview sẽ cài dependency và khởi động Vite dev server.`,
      },
    };
  }
  // E. Container-only
  else if ((signals.includes('dockerfile') || signals.includes('compose')) && !signals.includes('node-start') && !signals.includes('static-html')) {
    profile = {
      runtime_id: 'container-app',
      framework: signals.includes('compose') ? 'compose' : 'dockerfile',
      confidence: 0.88,
      startup_command: null,
      install_command: null,
      build_command: null,
      output_directory: null,
      expected_port: null,
      health_check_strategy: 'container-port',
      preview_supported: false, // needs Sandbox
      sandbox_required: true,
      unsupported_reason: CONTAINER_ONLY.en,
      reason_code: 'CONTAINER_ONLY',
      package_manager: packageManager,
      signals,
      guidance: {
        en: CONTAINER_ONLY.en,
        vi: CONTAINER_ONLY.vi,
      },
    };
  }
  // B. Node.js server
  else if (signals.includes('node-server') || (scripts.start && (deps.express || deps.fastify || deps.koa || deps.hono || Object.keys(deps).length > 0)) || (pkg.name && !signals.includes('static-html') && inferNodeEntry(files, pkg))) {
    const entry = inferNodeEntry(files, pkg);
    const startup = scripts.start || (entry ? `node ${entry}` : null);
    profile = {
      runtime_id: 'nodejs',
      framework: deps.express ? 'express' : deps.fastify ? 'fastify' : deps.koa ? 'koa' : deps.hono ? 'hono' : 'node',
      confidence: 0.9,
      startup_command: startup,
      install_command: installCmd(packageManager),
      build_command: scripts.build || null,
      output_directory: null,
      expected_port: null,
      health_check_strategy: 'http-root-or-health',
      preview_supported: Boolean(startup),
      sandbox_required: false,
      unsupported_reason: startup ? null : 'The app has no start command.',
      reason_code: startup ? null : 'MISSING_START_SCRIPT',
      package_manager: packageManager,
      signals,
      guidance: startup ? {
        en: 'Node.js app. Preview starts it and opens a browser.',
        vi: 'Ứng dụng Node.js. Xem thử sẽ khởi động và mở trình duyệt.',
      } : reasonMessages('MISSING_START_SCRIPT'),
    };
  }
  // A. Static web
  else if ((signals.includes('static-html') || hasIndex) && !(scripts.start && Object.keys(pkg || {}).length)) {
    profile = {
      runtime_id: 'static-web',
      framework: signals.includes('static-js') ? 'static-js' : 'static-html',
      confidence: 0.97,
      startup_command: null,
      install_command: null,
      build_command: null,
      output_directory: hasExact('index.html') ? '.' : ['public', 'www', 'static'].find((d) => files.has(`${d}/index.html`)) || '.',
      expected_port: null,
      health_check_strategy: 'http-root',
      preview_supported: true,
      sandbox_required: false,
      unsupported_reason: null,
      package_manager: packageManager,
      signals,
      guidance: {
        en: 'Static page. Preview serves the files directly.',
        vi: 'Trang tĩnh. Xem thử phục vụ các tệp trực tiếp.',
      },
    };
  }
  // F. Other languages
  else if (signals.includes('python') || signals.includes('php') || signals.includes('go') || signals.includes('java')) {
    const lang = signals.find((s2) => ['python', 'php', 'go', 'java'].includes(s2));
    profile = otherLanguageProfile(lang, files, { package_manager: packageManager, signals, build_command: null, output_directory: null, install_command: null });
  }
  // Fallback
  else {
    const fallbackCanPreview = Boolean(scripts.start || hasExact('index.html'));
    profile = {
      runtime_id: 'unknown',
      framework: null,
      confidence: 0.3,
      startup_command: scripts.start || null,
      install_command: pkg.name ? installCmd(packageManager) : null,
      build_command: scripts.build || null,
      output_directory: null,
      expected_port: null,
      health_check_strategy: 'http-root-or-health',
      preview_supported: fallbackCanPreview,
      sandbox_required: Boolean(dockerfile),
      unsupported_reason: fallbackCanPreview ? null : 'Unable to determine a supported preview runtime.',
      package_manager: packageManager,
      signals,
      guidance: {
        en: 'Runtime could not be confidently classified. Builder will attempt a best-effort native run.',
        vi: 'Không xác định rõ runtime. Builder sẽ thử chạy native theo cách tốt nhất có thể.',
      },
    };
  }

  return profile;
}


export function commandExists(bin) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try { fssync.accessSync(path.join(dir, bin + ext), fssync.constants.X_OK); return true; } catch { /* next */ }
    }
  }
  return false;
}

const NODE_ENTRY_CANDIDATES = ['server.js', 'index.js', 'app.js', 'main.js', 'src/server.js', 'src/index.js', 'src/app.js', 'server.mjs', 'index.mjs'];

function inferNodeEntry(files, pkg) {
  if (pkg?.main && files.has(String(pkg.main).replace(/^\.\//, ''))) return String(pkg.main).replace(/^\.\//, '');
  return NODE_ENTRY_CANDIDATES.find((f) => files.has(f)) || null;
}

function otherLanguageProfile(lang, files, base) {
  const has = (n) => files.has(n);
  const mk = (extra) => ({ ...base, runtime_id: 'other-language', framework: lang, confidence: 0.8, expected_port: null, health_check_strategy: 'http-root-or-health', sandbox_required: false, ...extra });
  const unavailable = (bin, code = 'TOOLCHAIN_MISSING') => mk({
    preview_supported: false, startup_command: null, reason_code: code,
    unsupported_reason: `${lang} preview needs "${bin}", which is not installed here.`,
    guidance: reasonMessages(code),
  });
  const noEntry = () => mk({
    preview_supported: false, startup_command: null, reason_code: 'NO_ENTRY',
    unsupported_reason: `No ${lang} start file was found.`,
    guidance: reasonMessages('NO_ENTRY'),
  });
  if (lang === 'python') {
    if (!commandExists('python3') && !commandExists('python')) return unavailable('python3');
    const py = commandExists('python3') ? 'python3' : 'python';
    const entry = ['app.py', 'main.py', 'server.py', 'run.py', 'manage.py'].find(has);
    if (!entry) return noEntry();
    const cmd = entry === 'manage.py' ? `${py} manage.py runserver 127.0.0.1:{PORT} --noreload` : `${py} ${entry}`;
    return mk({ startup_command: cmd, install_command: has('requirements.txt') ? 'pip install -r requirements.txt' : null, preview_supported: true, reason_code: null, unsupported_reason: null, guidance: { en: 'Python app. Preview starts it and opens a browser.', vi: 'Ứng dụng Python. Xem thử sẽ khởi động và mở trình duyệt.' } });
  }
  if (lang === 'php') {
    if (!commandExists('php')) return unavailable('php');
    const root = has('public/index.php') ? 'public' : '.';
    if (!has('index.php') && !has('public/index.php')) return noEntry();
    return mk({ startup_command: `php -S 127.0.0.1:{PORT} -t ${root}`, preview_supported: true, reason_code: null, unsupported_reason: null, guidance: { en: 'PHP app. Preview starts the PHP server.', vi: 'Ứng dụng PHP. Xem thử sẽ chạy máy chủ PHP.' } });
  }
  if (lang === 'go') {
    if (!commandExists('go')) return unavailable('go');
    if (!has('main.go') && !has('go.mod')) return noEntry();
    return mk({ startup_command: 'go run .', preview_supported: true, reason_code: null, unsupported_reason: null, guidance: { en: 'Go app. Preview builds and runs it.', vi: 'Ứng dụng Go. Xem thử sẽ biên dịch và chạy.' } });
  }
  // java: only a ready-made jar can be previewed (no Maven/Gradle build here)
  if (!commandExists('java')) return unavailable('java');
  const jar = [...files].find((f) => /(^|\/)[^/]+\.jar$/i.test(f) && !/(-sources|-javadoc|original-)/i.test(f));
  if (!jar) return mk({ preview_supported: false, startup_command: null, reason_code: 'NO_ENTRY', unsupported_reason: 'Java preview needs a built .jar file. Use Publish to build and run it.', guidance: { en: 'Java apps must be built first. Use Publish to run it.', vi: 'Ứng dụng Java cần được biên dịch trước. Hãy dùng Xuất bản để chạy.' } });
  return mk({ startup_command: `java -jar ${jar}`, preview_supported: true, reason_code: null, unsupported_reason: null, guidance: { en: 'Java app. Preview runs the built .jar.', vi: 'Ứng dụng Java. Xem thử chạy tệp .jar đã build.' } });
}

function installCmd(pm, includeDev = false) {
  if (pm === 'pnpm') return includeDev ? 'pnpm install' : 'pnpm install --prod';
  if (pm === 'yarn') return includeDev ? 'yarn install' : 'yarn install --production';
  return includeDev ? 'npm install --include=dev' : 'npm install --omit=dev';
}

/**
 * Backward-compatible wrapper used by existing callers.
 */
export async function detectAppProfile(sourceDir) {
  const p = await detectRuntimeProfile(sourceDir);
  return {
    kind: mapToLegacyKind(p),
    signals: p.signals,
    previewFriendly: p.preview_supported && !p.sandbox_required,
    preferPublish: !p.preview_supported || p.sandbox_required,
    hasDockerfile: p.signals.includes('dockerfile'),
    hasPackage: Boolean(p.startup_command || p.install_command),
    packageName: null,
    runtimeProfile: p,
    guidance: p.guidance,
  };
}

function mapToLegacyKind(p) {
  if (p.runtime_id === 'vite-frontend') return 'framework-spa-ssr';
  if (p.runtime_id === 'ssr-framework') return 'framework-spa-ssr';
  if (p.runtime_id === 'container-app') return 'container-app';
  if (p.runtime_id === 'nodejs') return 'node-start';
  if (p.runtime_id === 'static-web') return 'static';
  return 'unknown';
}

export default { detectRuntimeProfile, detectAppProfile };
