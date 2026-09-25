## 1.4.48 — Publish / GHCR preflight loop

### Cause
Publish and Check image both re-ran SoloHost runtime preflight. After the Dockerfile contract was already applied, DARE treated the same fingerprint as a second repair and threw RELEASE_RUNTIME_PREFLIGHT_STOPPED. Chat "fix Publish" then went to Improve, which could not propose a code change.

### Done
- Check image / waiting GHCR skips runtime preflight.
- Already-applied mkdir+chown (including parent path) is PASS, not another repair.
- No-op patch is alreadyFixed + CONTINUE, not STOPPED.
- STOPPED no longer aborts a publish that can still check GitHub/GHCR.
- "fix publish / GHCR / image" while source is already on GitHub routes to Check image.

### Files
- src/dare/engine.js
- src/jobs/pipeline.js
- tests/dare.test.js
- package.json / package-lock.json / CHANGELOG.md

### Not changed
Create App, Preview, Provider Hub, GitHub publisher internals, Upgrade Workshop UI, ZIP import/export, SoloHost package format.
