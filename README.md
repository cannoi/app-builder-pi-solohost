# App Builder — Pi SoloHost

A lean AI Builder for creating and testing SoloHost apps.

**Flow:** Idea → Build → Container Sandbox / Safe Preview → Playwright E2E → Publish to GitHub/GHCR → SoloHost install.

The Builder does not access the host Docker daemon and does not require a Docker socket. Preview runs inside the Builder runtime; GitHub Actions builds the final Docker image.

## Start

Run the Builder as a normal SoloHost app. Preview does not require Docker daemon access.


## Template Library (v1.8.32)

Open **Templates** in the header to browse the 146-entry catalog, search/filter by 15
categories, and describe an app idea for deterministic template matching. The catalog
distinguishes editable source, Docker package metadata, and reference-only entries.

Only a verified local source template can be copied into a new Builder project. Selecting
a source template queues the existing Improve workflow with the user's requested idea.
Docker package/reference entries remain recommendations until their real upstream image,
ports, environment variables, persistent storage, and SoloHost install manifest are verified.
See [TEMPLATE_LIBRARY.md](TEMPLATE_LIBRARY.md).
