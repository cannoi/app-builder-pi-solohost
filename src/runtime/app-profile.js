import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Classify imported / product apps so Builder preview does not treat
 * heavy Vite/SSR/container apps like simple generated Node apps.
 */
export async function detectAppProfile(sourceDir) {
  const files = new Set();
  try {
    const walk = async (dir, depth = 0) => {
      if (depth > 3) return;
      const ents = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of ents) {
        if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist' || e.name === '.output') continue;
        const rel = path.relative(sourceDir, path.join(dir, e.name)).replace(/\\/g, '/');
        if (e.isDirectory()) await walk(path.join(dir, e.name), depth + 1);
        else files.add(rel);
      }
    };
    await walk(sourceDir);
  } catch { /* empty */ }

  const pkg = JSON.parse(await fs.readFile(path.join(sourceDir, 'package.json'), 'utf8').catch(() => '{}'));
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const scripts = pkg.scripts || {};
  const dockerfile = await fs.readFile(path.join(sourceDir, 'Dockerfile'), 'utf8').catch(() => '');

  const signals = [];
  const has = (re) => [...files].some((f) => re.test(f));

  if (deps.vite || scripts.dev?.includes('vite') || files.has('vite.config.ts') || files.has('vite.config.js')) {
    signals.push('vite');
  }
  if (deps['@tanstack/react-start'] || deps['@tanstack/start'] || deps['@tanstack/react-router']) {
    signals.push('tanstack');
  }
  if (deps.next || files.has('next.config.js') || files.has('next.config.mjs')) signals.push('next');
  if (deps.nuxt || files.has('nuxt.config.ts')) signals.push('nuxt');
  if (deps['react-router'] || deps['react-router-dom']) signals.push('react-router');
  if (dockerfile.includes('vite build') || dockerfile.includes('.output/') || /FROM .+ AS /i.test(dockerfile)) {
    signals.push('multi-stage-docker');
  }
  if (files.has('docker-compose.yml') || files.has('solohost/docker-compose.yml')) signals.push('compose');
  if (!scripts.start && (scripts.dev || scripts.build)) signals.push('build-then-run');
  if (deps['better-auth'] || deps['@electric-sql/pglite'] || deps.prisma) signals.push('heavy-data');

  const kind =
    signals.includes('vite') || signals.includes('tanstack') || signals.includes('next') || signals.includes('nuxt')
      ? 'framework-spa-ssr'
      : signals.includes('multi-stage-docker') || signals.includes('compose')
        ? 'container-app'
        : scripts.start
          ? 'node-start'
          : 'unknown';

  const previewFriendly = kind === 'node-start' && !signals.includes('multi-stage-docker');
  const preferPublish = !previewFriendly;

  return {
    kind,
    signals,
    previewFriendly,
    preferPublish,
    hasDockerfile: Boolean(dockerfile),
    hasPackage: Boolean(pkg.name || scripts.start || scripts.dev),
    packageName: pkg.name || null,
    guidance: preferPublish
      ? {
          en: 'This looks like a full framework/container app (Vite, React, Docker build). Builder preview is limited — use Publish → GHCR → SoloHost for a real run. Improve only if you want source changes.',
          vi: 'Đây là app framework/container (Vite, React, Docker build). Xem trước trong Builder bị giới hạn — hãy Publish → GHCR → SoloHost để chạy thật. Chỉ Improve khi muốn sửa mã nguồn.',
        }
      : {
          en: 'Simple Node/static app — Builder preview can try a local run.',
          vi: 'App Node/tĩnh đơn giản — Builder có thể chạy thử local.',
        },
  };
}

export default { detectAppProfile };
