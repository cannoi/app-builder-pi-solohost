## Reliability upgrade — 2026-09-21

- GitHub publishing now follows an existing repository's default branch and generates the GHCR workflow with the exact release tag being published.
- GitHub image uploads now discover and use the repository default branch instead of assuming `main`.
- Builder requests now persist a 30-day work plan with per-step status, files changed, result/error notes, and a handoff for the next AI/session.
- Edit/improve operations keep checkpoints, reject duplicate or oversized patch scopes, verify the result, and roll back when verification worsens.
- AI calls use bounded timeouts, transient retry/fallback, safer model selection, and more actionable provider errors.
- Project chat/activity history is server-persisted across browsers and pruned after 30 days; a new browser opens the most recently updated project.

# Changelog

## 1.4.26

- GitHub release flow now waits for the exact pushed commit's GHCR image before creating the SoloHost install kit.
- Failed GitHub Actions builds are read and classified; one low-risk AI repair can be proposed/applied, verified, and rolled back on regression.
- Generated workflows test the actual container web port (including common ports such as 3000) before pushing the tested image.
- Container-only Run uses the protected Sandbox automatically when available; ordinary Node/static projects stay on native preview.
- AI provider/model switching is normalized with clearer auth, quota, model, network, and billing errors.
- Settings uses a compact no-scroll key/token layout and keeps Sandbox setup automatic.
- Build/Edit/Repair steps now checkpoint and verify forward progress before the next mutating step.
- Builder keeps a proactive next-step guide for publish and SoloHost installation.


## 1.4.13

- ⬆ Zip imports an app, unpacks it, and flattens a single wrapper folder.
- ⬇ Zip downloads a real .zip via blob (works in Pi Desktop WebView).
- runWithRepair is inside the pipeline again so Run is not "runProject is not defined".


## 1.4.14
- Native preview serves index.html + /health even when package.json start script crashes (fixes fetch failed on Run).

## 1.4.15
- Preview iframe no longer proxies to Builder :8080. Uses the app preview port.

## 1.4.16
- Gemini 503/429 rotates to the next model instead of failing the whole request.
- Bundled Sandbox Benchmark demo (🧪 Sandbox). Run advises testing sandbox first.
- Preview proxies /api and /health to the spawned app process when present.

## 1.4.17
- Preview iframe now rewrites fetch("/api") and /health to /preview/<slug>/__app__/ so product APIs are not sent to Builder.

## 1.4.18
- Preview rewrites root CSS/image URLs and adds a base href so public assets load inside the iframe.
- SMART BUILD MODE added to the Builder system prompt.

## 1.4.19
- ZIP import uses system unzip first so CSS/images from Windows/macOS zips extract fully.
- Preview searches public/dist/www/static/assets and falls back to disk if the live preview port 404s an asset.

## 1.4.20
- Preview/sandbox DNS + PREVIEW_ONLINE so product apps can use the Internet.
- Failures include WHY, FIX, and COPY_FOR_AI.
- Repair prompt forbids full rewrites. Activity log is stored and sent to AI.

## 1.4.22
- RUN no longer treats every app that has Dockerfile/compose as a container-only app.
- Native preview is used when index.html or a Node start script exists. Podman Sandbox is required only for image-only projects.

## 1.4.23
- Paste a GHCR image to generate SoloHost docker-compose.yml + config_options.yml without Run.
- Replaced Windows publisher with GitHub-ZIP-Image-Publisher-v5.0.ps1.

## 1.4.24
- Publish uses git CLI first (1.4.21 path), GitHub API as fallback.
- Fallback .ps1 is copied into the image and resolved from multiple paths.
- RUN no longer blocks container-looking apps when Sandbox is absent; native preview is used.

## 1.4.25
- Windows GitHub publisher v5.0 only (Git Data API + Contents fallback).
- Removed unused .bak files and the previous v4.0 script.

## 1.4.27
- Always wait for the matching GitHub Actions run (any workflow file).
- Deterministic repair when smoke test misses the app listen port.
- Compact Settings sheet so Save stays on screen.

## 1.4.28
- Builder Expert Mode: classify failure layer before any code edit.
- SoloHost/GitHub/Preview/Docker/network reports inspect first; app code changes only with evidence.
