# Sandbox

The Builder sandbox uses rootless Docker through its REST API and Playwright for browser validation.

Security boundaries:
- The Builder has Docker socket access because it must build, run, test and clean generated app containers.
- Preview containers are temporary and labeled as Builder sandboxes.
- Preview containers expose only the app UI port and run with CPU, memory and PID limits.
- Playwright runs headless and captures page title/load metrics plus an optional screenshot.
- Containers are stopped and removed after E2E validation.

Docker socket access is powerful. The Builder runs generated apps with resource limits and cleans temporary containers/images after testing. Do not expose the Docker socket itself to the network.
