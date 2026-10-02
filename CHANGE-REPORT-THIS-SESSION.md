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


## 2026-09-28 — Rule Engine execution hardening

- Rule execution now uses a bounded task/cycle engine instead of sending the whole Rule as a one-shot AI request.
- Nullable/missing EXECUTION configuration is normalized safely; `maxCycles` always has a bounded default.
- Rule runs auto-apply safe low/medium-risk patches and stop only for genuine user decisions such as credentials or high-risk changes.
- Every task is checkpointed and verified; repeated source+patch fingerprints are blocked.
- Definition-of-Done entries are evaluated before any repair is proposed.
- Existing normal Upgrade requests keep the Apply approval flow.
- Bundled Rules now include bounded execution and Definition-of-Done contracts.
- No UI, provider, GitHub, GHCR, or SoloHost architecture was intentionally changed.


## 1.4.61 — Repair / Upgrade workflow integrity and access hardening

### Done
- Tie test and preview evidence to a SHA-256 fingerprint of the current project source; block publishing when any evidence is stale.
- Keep chat-triggered Improve changes on the same verification path as direct Improve actions, and report success only after checks and preview pass.
- Limit AI context and prioritize files relevant to the requested change to reduce overload on smaller/free models.
- Restore snapshots as a complete source replacement so rollback removes files added after the checkpoint; restore the checkpoint if a multi-file Upgrade write fails.
- Protect project APIs and preview routes with a signed, HTTP-only session; require an operator-configured SoloHost password, rate-limit failed sign-ins, and reject cross-origin login and unsafe API requests.
- Sandbox external preview HTML without granting same-origin access.

### Verification
- Workflow/auth regression tests: 13/13 passed.
- Related configuration, hardening, UI, and preview tests: 50/50 passed.
- Full suite: 237/240 passed. Two existing Feedback Hub tests assert that the current fallback API must not exist, while the UI and server still implement it; one ZIP test requires the unavailable `unzip` executable on Windows.

### Not done
- The previously identified DNS rebinding/SSRF risk in external preview host resolution remains; it was not part of the selected High-severity fixes.
- The three full-suite failures above remain outside the workflow/auth changes.
