# Changelog

## 1.8.7
- Fix container exit on smoke: chown after COPY, DATA_DIR=/app/data, preflight yaml/sqlite/octokit during image build
- playwright moved to optionalDependencies; Chromium removed from image (E2E optional)
- docker-entrypoint + src/boot.js so startup crashes always print to logs
- Smoke prints full container logs + exit code on failure

## 1.8.6
- In-container health probe and native docker build
