# App Builder — Pi SoloHost

A lean AI Builder for creating and testing SoloHost apps.

**Flow:** Idea → Build → Container Sandbox / Safe Preview → Playwright E2E → Publish to GitHub/GHCR → SoloHost install.

The Builder does not access the host Docker daemon and does not require a Docker socket. Preview runs inside the Builder runtime; GitHub Actions builds the final Docker image.

## Start

Run the Builder as a normal SoloHost app. Preview does not require Docker daemon access.
