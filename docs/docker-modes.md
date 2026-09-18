# Container engine

## Docker sandbox

App Builder uses the SoloHost Docker engine for image build, preview, inspection and cleanup. The Builder receives Docker socket access as part of its normal installation.

Keep `DOCKER_MODE=power` (the default). No Docker API URL is required. The Docker socket is local to the SoloHost host and must not be exposed over the network.

## Preview testing

After an image is built, the Builder provisions a temporary container on an isolated network, publishes its UI port, waits for `/health`, then runs Playwright headless E2E against the preview URL. The preview container is torn down after validation.

## Compatibility

The existing `/api/docker/*` route names are retained for UI/API compatibility, but their implementation now uses the Docker sandbox.
