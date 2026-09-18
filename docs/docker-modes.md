# Runtime

App Builder uses the native preview runtime. It never mounts or connects to the host Docker daemon.

- Build/Run/Check can validate the app without Docker socket access.
- Playwright validates the live local preview before success is reported.
- Publish uploads source to GitHub; GitHub Actions builds and pushes the final GHCR image.
- The generated SoloHost package contains only the published image reference plus its normal config files.
