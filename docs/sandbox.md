# Preview Sandbox

App Builder supports two preview engines without a host Docker socket:

1. **Container Sandbox (Podman API)** — selected automatically when `PODMAN_API_URL` is configured. The Builder sends the build context to the protected Podman API, creates a temporary preview container with memory/CPU limits and a loopback-only published port, waits for `/health`, then runs Playwright against the live UI.
2. **Native Preview fallback** — used when the Container Sandbox is not configured or when `PREVIEW_MODE=auto` cannot complete the container preview. It runs the generated app in a temporary Builder workspace and still performs health + Playwright checks.

`PREVIEW_MODE` values: `auto` (recommended), `container`, or `native`.

The Builder never mounts `/var/run/docker.sock`, does not invoke the host Docker CLI, and does not report preview success without a health check and browser test. Raw shell/container commands remain blocked.

The Container Sandbox endpoint must be a protected Podman service. The Builder does not expose or create a host Docker daemon connection.
