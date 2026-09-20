# Build and Preview Runner

The preview flow is:

1. Validate the generated source.
2. Select `Container Sandbox` when `PODMAN_API_URL` is configured and `PREVIEW_MODE` is `auto` or `container`.
3. Build a temporary preview image through the protected Podman API.
4. Start a temporary container with CPU/memory limits and a loopback-only port.
5. Wait for `/health` and run Playwright against the live UI.
6. Keep the container only for an explicit live Run; test-only runs tear it down.
7. If `auto` mode cannot use the Container Sandbox, fall back to native preview and report the runtime used.
8. Never use a host Docker socket.

GitHub Actions remains responsible for the final published SoloHost image.
