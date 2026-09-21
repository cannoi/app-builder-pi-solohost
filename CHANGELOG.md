# Changelog

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
- Replaced Windows publisher with GitHub-ZIP-Image-Publisher-v4.0.ps1.
