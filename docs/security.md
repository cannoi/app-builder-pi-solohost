# Security

App Builder does not receive host Docker daemon credentials and never mounts `/var/run/docker.sock`.

When `PODMAN_API_URL` is configured, preview execution uses the Container Sandbox over its protected Podman HTTP API. Preview containers are temporary, receive CPU/memory limits, publish their UI on a loopback host port, and are removed after non-live tests. Raw shell commands remain blocked.

When the Container Sandbox is unavailable, `PREVIEW_MODE=auto` falls back to the built-in native preview so the user can still test the app. Native preview is a process-level safety boundary, not a kernel-level security boundary; it should not be described as a hostile-code sandbox.

Generated applications are scanned for secrets, unsafe Docker settings, and Docker socket references before publication.
