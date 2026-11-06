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

## 2026-10-04 — Popular-user flow / Publish boundary hardening

### Done
- Source-project validation and SoloHost-install-package validation now have separate contexts.
- A source repository may contain `build:` for GitHub Actions image builds; a SoloHost install package still requires `image:` and rejects `build:`.
- Publish now explicitly validates the source context, preventing the SoloHost-only `build:` rule from incorrectly blocking GitHub source publication.
- Automatic AI edits may update `.env.example` / example environment templates; real `.env`, private-key and secret-file paths remain protected.
- Added regression coverage for source-vs-SoloHost validation and protected-file behavior.
- Existing AI response normalization, provider fallback, loop protection, user-defined configuration handling, language routing, Upgrade resume and UI behavior were preserved.

### Validation
- Focused recovery/security/publish/build/upgrade/UI regression suite: PASS.
- Additional sandbox, scanner, SoloHost, UI, Upgrade and ZIP suites: PASS.
- The complete wildcard test command still has a pre-existing long-running/cleanup interaction around the early runtime/safe-actions sequence when all test files are launched together; the affected `safe-actions.test.js` passes independently, and the full relevant suites were executed independently without failures.

### Not intentionally changed
- Main Builder UI architecture.
- Provider Hub architecture.
- Upgrade Workshop architecture.
- Sandbox/Preview architecture.
- ZIP/import/export format.
- GitHub API upload architecture.
- SoloHost package contract beyond the validation-context correction.
