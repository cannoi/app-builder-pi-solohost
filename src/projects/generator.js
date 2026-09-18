import fs from 'node:fs/promises';
import path from 'node:path';
import { writeSafeFile, copyDir, ensureDir, listFiles } from '../utils/fsx.js';
import { safeSlug } from '../utils/ids.js';

export function localAnalysis(idea) {
  const name = guessName(idea);
  return {
    name,
    slug: safeSlug(name),
    summary: idea.slice(0, 280),
    target_users: ['SoloHost operators', 'small communities', 'Pi Pioneers'],
    core_features: guessFeatures(idea),
    optional_features: ['Email notifications', 'Dark mode'],
    recommended_stack: {
      language: 'javascript',
      runtime: 'node',
      framework: 'express',
      database: 'sqlite',
      frontend: 'static-html',
    },
    risks: ['Payments and identity need careful review before public use'],
    questions: [],
    estimated_complexity: idea.length > 240 ? 'medium' : 'low',
    source: 'local-defaults',
  };
}

export function localPlan(idea, analysis) {
  return {
    name: analysis.name,
    summary: analysis.summary,
    user_flow: [
      'Open the app',
      'See the main action clearly',
      'Complete the primary task',
      'Check health',
    ],
    features: analysis.core_features.map((f) => ({ name: f, included: true, why: 'Requested or implied by the idea' })),
    architecture: {
      style: 'single-container',
      components: ['web-ui', 'api', 'sqlite'],
    },
    data_model: [{ entity: 'item', fields: ['id', 'title', 'created_at'] }],
    security_model: [
      'No secrets in source',
      'Listen on 0.0.0.0:8080 inside the container',
      'Validate input',
    ],
    testing_strategy: ['Health check', 'Basic HTTP test', 'Secret scan'],
    deployment_strategy: ['Docker Compose on SoloHost', 'Persistent volume for data'],
    decisions: [{
      decision: 'SQLite + Express',
      why: 'Small app, simple deployment, no extra database server.',
      alternatives: ['PostgreSQL', 'static-only'],
      risk: 'low',
      cost: 'low',
    }],
    complexity: analysis.estimated_complexity,
    source: 'local-defaults',
  };
}

export async function writeGithubWorkflow(root, project = {}) {
  const version = String(project.version || '0.1.0').replace(/[^0-9A-Za-z._-]/g, '-');
  const yml = `name: Build SoloHost image
on:
  push:
  workflow_dispatch:
permissions:
  contents: read
  packages: write
jobs:
  docker:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: \${{ github.actor }}
          password: \${{ secrets.GITHUB_TOKEN }}
      - uses: docker/metadata-action@v5
        id: meta
        with:
          images: ghcr.io/\${{ github.repository }}
          tags: |
            type=raw,value=latest
            type=raw,value=${version}
            type=ref,event=tag
            type=sha,prefix=
      - uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: \${{ steps.meta.outputs.tags }}
          labels: \${{ steps.meta.outputs.labels }}
`;
  await writeSafeFile(root, '.github/workflows/docker.yml', yml);
  await writeSafeFile(root, '.dockerignore', 'node_modules\n.git\nsolohost\n*.zip\n.env\n');
  return ['.github/workflows/docker.yml'];
}

export async function writeGeneratedFiles(root, files) {
  const written = [];
  for (const file of files || []) {
    if (!file?.path) continue;
    await writeSafeFile(root, file.path, String(file.content ?? ''));
    written.push(file.path);
  }
  return written;
}

export async function scaffoldFromTemplate(templatesDir, dest, vars) {
  const src = path.join(templatesDir, 'hello-ai-app');
  await ensureDir(dest);
  await copyDir(src, dest);
  const files = await listFiles(dest);
  for (const rel of files) {
    const full = path.join(dest, rel);
    let text = await fs.readFile(full, 'utf8').catch(() => null);
    if (text == null) continue;
    text = text
      .replaceAll('{{APP_NAME}}', vars.name)
      .replaceAll('{{APP_SLUG}}', vars.slug)
      .replaceAll('{{APP_SUMMARY}}', vars.summary || vars.idea || '')
      .replaceAll('{{APP_IDEA}}', vars.idea || '');
    await fs.writeFile(full, text);
  }
  return files;
}

function guessName(idea) {
  const cleaned = String(idea || '').replace(/['"]/g, '');
  const words = cleaned.split(/\s+/).filter((w) => w.length > 2).slice(0, 4);
  if (!words.length) return 'Hello AI App';
  return words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

function guessFeatures(idea) {
  const s = idea.toLowerCase();
  const feats = ['Home page', 'Health check'];
  if (/subscr|payment|pi\b/.test(s)) feats.push('Pi payment placeholder', 'Subscription status');
  if (/monitor|node|alert/.test(s)) feats.push('Status dashboard', 'Alert settings');
  if (/chat|message/.test(s)) feats.push('Message inbox');
  if (/shop|sell|store/.test(s)) feats.push('Product list', 'Checkout placeholder');
  return feats.slice(0, 6);
}
