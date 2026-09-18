# Build Runner

V1 runs the orchestration inside the Builder container while the generated app containers are created through the mounted SoloHost Docker socket.

Before Build or Run is reported as successful, the runner:

1. validates the project;
2. builds the requested image through the SoloHost Docker engine;
3. verifies the image exists;
4. provisions a temporary preview container with resource limits;
5. waits for `/health`;
6. runs Playwright headless against the preview URL;
7. captures page title/load metrics and an optional screenshot;
8. tears down the temporary test container after E2E validation.

The runner uses the mounted Docker socket because Build/Run/Test must create and clean app containers.
