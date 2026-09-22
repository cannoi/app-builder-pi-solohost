# Preview Sandbox

App Builder supports two preview engines without a host Docker socket:

1. **Automatic Container Sandbox (Podman API)** — the Builder detects container-only apps and uses the protected `PODMAN_API_URL` supplied by the platform when available. No user installation or manual Docker setup is required. The Builder creates a temporary preview container with memory/CPU limits and a loopback-only published port, waits for `/health`, then runs Playwright against the live UI.
2. **Native Preview fallback** — used for ordinary Node/static apps, or when `PREVIEW_MODE=auto` has no usable protected Container Sandbox. It runs the generated app in a temporary Builder workspace and still performs health + Playwright checks.

`PREVIEW_MODE` values: `auto` (recommended), `container`, or `native`.

The Builder never mounts `/var/run/docker.sock`, does not invoke the host Docker CLI, and does not report preview success without a health check and browser test. Raw shell/container commands remain blocked.

The Container Sandbox endpoint, when present, must be a protected Podman service supplied by the hosting platform. The Builder does not expose or create a host Docker daemon connection.
