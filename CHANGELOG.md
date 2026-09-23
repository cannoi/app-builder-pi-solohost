## 1.4.38
- DARE (Deterministic Auto Repair Engine) runs before AI on preview crash and GitHub Actions failure.
- Safe rules: missing npm package, unique start script, localhost bind, sqlite data dirs, workflow packages:write.
- Loop cap: one auto-repair per fingerprint per cycle. AI quota errors no longer block those fixes.
- App-logic TypeErrors are not auto-patched.

## 1.4.37
- Deterministic GitHub Actions repair: if the image crashes with a missing Node package (example: sqlite3 used but not in package.json), Builder adds the dependency and republishes without waiting for AI quota.
- New apps are scanned for require()/import vs package.json before the first GitHub push.
- Smoke test sets PORT=8080 and resolves the locally built image tag if the version tag is missing.

## 1.4.36
- Publish no longer loops on a stale npm-test failure after a passing live preview.
- Successful Run refreshes the saved verification report so Release can continue.
- "Release blocked / tests failed" chat is routed to Run, not another Improve loop.
- Chat lines persist across Preview → Back so work history is not lost.
- Provider selector applies immediately (`ai.refresh`) and lists every connected provider.
- SoloHost compose prefers Dockerfile EXPOSE, sets PORT, and never writes a local-only image name.

## 1.4.35

- Prevent repeated identical repair loops with a short-window action guard.
- Refresh saved verification results after Improve so Publish never reuses stale failed tests.
- Persist recent work history and restore it when returning from Preview or a new Builder session.
- Make the main AI selector choose a connected provider immediately; keep verified two-model pairing available.
- Lock explicit provider selection so AI cannot silently fall back to another legacy provider.
- Normalize legacy Provider Hub model state before array operations.
- Generate SoloHost install packages from the app's detected container port instead of assuming 8080.

## 1.4.33

- Fix Provider Hub crash models.find.
- Add token is enough; first key wins. Settings: token list + GitHub + Save.

# v1.4.33 — AI Provider Hub Simplified

- Fixed malformed Provider Hub model state that caused `models.find is not a function`.
- Added canonical `loadHub()` UI loading path and removed stale mode controls.
- Simplified provider setup to Provider → Token → Add, then Save.
- Added verified Model 1 + optional Model 2 (Builder + reviewer) selection.
- Selected model pairs are used for code-task review without exposing provider credentials.

## 1.4.31 — AI Provider Hub

- Standardized AI Provider Hub is now the single Builder AI access layer.
- Added encrypted-at-rest credential vault and removed new AI keys from Builder state/runtime secret persistence.
- Added credential-first discovery, verified-model probing, AUTO/PROVIDER/MANUAL routing and bounded fallback.
- Added adapters for OpenAI, Gemini, DeepSeek, Anthropic, OpenRouter, Groq, Mistral, xAI and custom OpenAI-compatible endpoints.
- Kept existing Builder UI/workflows intact outside the AI connection layer.

## 1.4.30

- AI Provider Hub: shared adapters, credential validation, model discovery, AUTO routing and fallback.
- Existing DeepSeek/Gemini keys migrate. Chat/build/repair still use ai.complete().

## 1.4.29

- Universal App Factory Expert Mode: CREATE / MODIFY / REPAIR / DIAGNOSE. Targeted changes are not blocked by diagnosis. App-type rules stay local to the project.
- Job lock + live status stay on while AI repair/build runs so extra commands cannot start.
- Rollback button on each Builder reply restores the latest checkpoint.
- Help actions download Windows helpers: run-docker-app.ps1 and GitHub-ZIP-Image-Publisher-v5.0.ps1, with a short how-to in chat.

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
