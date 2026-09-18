# App Builder — Pi SoloHost V1.3.4

## 1. Start the Builder

Start the Builder with Docker Compose on SoloHost:

```bash
docker compose up -d --build
```

Open `http://HOST:18795/`. Build/Run use the built-in safe preview runtime and do not require host Docker access.

Safe preview testing is built in. No Docker socket, privileged mode, or manual engine configuration is required.


DeepSeek is the default AI provider; Gemini is optional.

## 2. Build and test

The Builder automatically performs:

```text
Understand → Plan → Build → Container Sandbox / Safe Preview → Playwright E2E → Result
```

The temporary preview runtime is removed after E2E validation (Container Sandbox when configured; native fallback otherwise).

## 3. Publish

Use Publish in App Builder. GitHub Actions builds and publishes the final GHCR image. Do not install a SoloHost package until the exact GHCR image tag is confirmed.
