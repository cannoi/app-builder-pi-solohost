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
  const listenPort = Number(project.listenPort || 0);
  const preferred = listenPort > 0 ? String(listenPort) : '8080';
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
    permissions:
      contents: read
      packages: write
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: \${{ github.actor }}
          password: \${{ secrets.GITHUB_TOKEN }}

      - name: Lowercase image name
        id: image
        shell: bash
        run: |
          set -euo pipefail
          REPO="$(echo "ghcr.io/\${{ github.repository }}" | tr '[:upper:]' '[:lower:]')"
          echo "repo=\${REPO}" >> "$GITHUB_OUTPUT"
          echo "tag_sha=\${REPO}:\${{ github.sha }}" >> "$GITHUB_OUTPUT"
          echo "tag_latest=\${REPO}:latest" >> "$GITHUB_OUTPUT"
          echo "tag_version=\${REPO}:${version}" >> "$GITHUB_OUTPUT"

      - name: Build image
        uses: docker/build-push-action@v6
        with:
          context: .
          load: true
          tags: |
            \${{ steps.image.outputs.tag_sha }}
            \${{ steps.image.outputs.tag_latest }}
            \${{ steps.image.outputs.tag_version }}

      - name: Smoke test image
        shell: bash
        run: |
          set -uo pipefail
          SHA="\${{ github.sha }}"
          SHORT_SHA="$(echo "$SHA" | cut -c1-12)"
          REPO="\${{ steps.image.outputs.repo }}"
          IMAGE="\${{ steps.image.outputs.tag_sha }}"

          resolve_image() {
            local candidate
            for candidate in \\
              "$IMAGE" \\
              "\${REPO}:\${SHA}" \\
              "\${REPO}:\${SHORT_SHA}" \\
              "\${REPO}:latest"
            do
              [[ -n "$candidate" ]] || continue
              if docker image inspect "$candidate" >/dev/null 2>&1; then
                echo "$candidate"
                return 0
              fi
            done
            candidate="$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -iF "$SHA" | head -n1 || true)"
            if [[ -n "$candidate" ]] && docker image inspect "$candidate" >/dev/null 2>&1; then
              echo "$candidate"
              return 0
            fi
            candidate="$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -iF "$SHORT_SHA" | head -n1 || true)"
            if [[ -n "$candidate" ]] && docker image inspect "$candidate" >/dev/null 2>&1; then
              echo "$candidate"
              return 0
            fi
            if [[ -n "$REPO" ]]; then
              candidate="$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -iF "$REPO" | head -n1 || true)"
              if [[ -n "$candidate" ]] && docker image inspect "$candidate" >/dev/null 2>&1; then
                echo "$candidate"
                return 0
              fi
            fi
            return 1
          }

          if ! IMAGE="$(resolve_image)"; then
            echo "Expected immutable release image tag was not found locally for sha=$SHA"
            docker images || true
            exit 1
          fi
          FULL_TAG="\${REPO}:\${SHA}"
          if [[ -n "$REPO" ]] && [[ "$IMAGE" != "$FULL_TAG" ]]; then
            docker tag "$IMAGE" "$FULL_TAG" 2>/dev/null || true
            if docker image inspect "$FULL_TAG" >/dev/null 2>&1; then
              IMAGE="$FULL_TAG"
            fi
          fi
          echo "Smoke-testing the exact release image: $IMAGE"
          IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$IMAGE")"

          mapfile -t EXPOSED < <(docker image inspect "$IMAGE" --format '{{range $p, $_ := .Config.ExposedPorts}}{{println $p}}{{end}}' 2>/dev/null | sed -E 's#/.*$##' | sed '/^$/d' | sort -u)
          IMG_PORT="$(docker image inspect "$IMAGE" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | sed -n 's/^PORT=//p' | head -n1 || true)"
          COMMON=(${preferred} 8080 3000 3001 4000 4173 5000 5173 6080 8000 8081 8501 80)
          PORTS=()
          add_port() {
            local p="$1"
            [[ "$p" =~ ^[0-9]+$ ]] || return 0
            local existing
            for existing in "\${PORTS[@]:-}"; do [[ "$existing" == "$p" ]] && return 0; done
            PORTS+=("$p")
          }
          [[ -n "\${IMG_PORT:-}" ]] && add_port "$IMG_PORT"
          for p in "\${EXPOSED[@]:-}"; do add_port "$p"; done
          for p in "\${COMMON[@]}"; do add_port "$p"; done
          if [[ "\${#PORTS[@]}" -eq 0 ]]; then PORTS=(8080); fi
          if [[ "\${#PORTS[@]}" -gt 12 ]]; then PORTS=("\${PORTS[@]:0:12}"); fi

          RUN_ARGS=()
          i=0
          for p in "\${PORTS[@]}"; do
            RUN_ARGS+=( -p "127.0.0.1:$((18080+i)):$p" )
            i=$((i+1))
          done
          APP_PORT="\${PORTS[0]}"
          echo "Smoke-testing with PORT=$APP_PORT (candidates: \${PORTS[*]})"
          docker rm -f paf-smoke >/dev/null 2>&1 || true
          docker run -d --name paf-smoke \\
            -e NODE_ENV=production \\
            -e PORT="$APP_PORT" \\
            -e BIND=0.0.0.0 \\
            -e FACTORY_BIND=0.0.0.0 \\
            -e HOST=0.0.0.0 \\
            "\${RUN_ARGS[@]}" \\
            "$IMAGE_ID"
          trap 'docker logs paf-smoke 2>/dev/null || true; docker rm -f paf-smoke >/dev/null 2>&1 || true' EXIT

          http_up() {
            local url="$1"
            local code
            code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$url" || echo 000)"
            [[ "$code" =~ ^[1-5][0-9][0-9]$ ]]
          }

          for i in $(seq 1 60); do
            j=0
            for p in "\${PORTS[@]}"; do
              host_port=$((18080+j))
              if http_up "http://127.0.0.1:\${host_port}/health" \\
                || http_up "http://127.0.0.1:\${host_port}/ready" \\
                || http_up "http://127.0.0.1:\${host_port}/" \\
                || http_up "http://127.0.0.1:\${host_port}/api/health"; then
                echo "Smoke test passed on container port \${p} (host \${host_port})."
                exit 0
              fi
              j=$((j+1))
            done
            if ! docker inspect -f '{{.State.Running}}' paf-smoke 2>/dev/null | grep -q true; then
              echo "Container exited before smoke test passed."
              docker logs paf-smoke 2>/dev/null || true
              exit 1
            fi
            sleep 2
          done
          echo "Container did not become reachable on any detected/common web port within 120 seconds."
          docker logs paf-smoke 2>/dev/null || true
          exit 1

      - name: Push tested image
        shell: bash
        run: |
          set -euo pipefail
          for tag in \\
            "\${{ steps.image.outputs.tag_sha }}" \\
            "\${{ steps.image.outputs.tag_latest }}" \\
            "\${{ steps.image.outputs.tag_version }}"
          do
            [[ -n "$tag" ]] || continue
            if docker image inspect "$tag" >/dev/null 2>&1; then
              echo "Pushing tested image: $tag"
              docker image push "$tag"
            fi
          done
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
