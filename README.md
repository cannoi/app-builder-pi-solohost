# App Builder — Pi SoloHost

A lean AI Builder for creating and testing SoloHost apps.

**Flow:** Idea → Build → Docker sandbox → Playwright E2E → image file → next step → Publish.

The Builder uses the host Docker socket through the SoloHost installation. No separate sandbox API or manual sandbox configuration is required.

## Start

Run the Builder with SoloHost in the normal Docker-enabled setup. `DOCKER_MODE=power` is the default.
