# App Builder — Pi SoloHost V1.3.4

## 1. Start the Builder

Start the Builder with Docker Compose on SoloHost:

```bash
docker compose up -d --build
```

Open `http://HOST:18795/`. The factory mounts `/var/run/docker.sock` so Build/Run can create app containers.

Docker sandbox testing is built in. No separate sandbox URL or manual engine configuration is required. Keep `DOCKER_MODE=power` (the default).


DeepSeek is the default AI provider; Gemini is optional.

## 2. Build and test

The Builder automatically performs:

```text
Understand → Plan → Build → Docker sandbox → Playwright E2E → Result
```

The temporary test container is removed after E2E validation.

## 3. Download a Docker-loadable image

After a successful Build/Run, the Builder provides a tested `.tar` image file. It is exported explicitly as a **Docker archive** and checked for `manifest.json` before the download is shown.

On a machine with Docker installed:

```bash
docker load -i your-app-image.tar
```

Then verify:

```bash
docker images
```

## 4. Add an AI key

Open **⚙ Settings**. No setup wizard blocks the main chat.

- **DeepSeek** — default
- **Gemini** — optional
- GitHub — optional until you want automated publishing

## 5. Build an app

Describe the app naturally. The Builder leads the workflow, tests the result, reports the exact error when something fails, and provides the tested image when the build succeeds.

## 6. Improve an app

After Run, tell the Builder what you want changed. It creates a restore point, patches the app, retests it, and reports the new result.

## 7. Attach files

Use **📎** to attach ZIP projects, source/config files, images, PDFs and common documents.

## 8. Inspect a running container

Press **🐳 Apps** to inspect available containers through the Docker API. Environment values are masked and unsafe Docker-socket mounts remain security findings.

## 9. Publish

When you are satisfied, choose **🚀 Publish** or ask the Builder to publish. Configure `GITHUB_TOKEN` and `GITHUB_OWNER` for automated GitHub/GHCR publishing.

The Builder verifies the tested image before it prepares a SoloHost release package.
