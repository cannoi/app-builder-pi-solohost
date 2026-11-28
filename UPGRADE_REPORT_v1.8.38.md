# App Builder v1.8.38 — template enforcement partial upgrade

## Implemented
- When template mode is enabled for auto-build, a missing/unusable verified editable source template now stops the build with a clear user-facing explanation instead of silently falling through to demo/AI-only generation.
- Template instantiation errors now fail explicitly; no demo or AI-only fallback is used in template mode.
- Bumped package version to 1.8.38 and updated the two shipped compose image tags.

## Not completed / not verified
- The existing tool loop has not yet been wired into the initial app-creation pipeline. Existing create flow still uses the current multi-phase generator and its current verification behavior.
- No live network/template fetch or end-to-end template creation was run.
- Full test suite did not finish: the environment lacks installed `yaml` dependency; additional baseline compose-version assertions expect 1.8.37, and the test command timed out. No Docker build/smoke test was run.

## Scope
Only `src/jobs/pipeline.js`, `package.json`, `package-lock.json`, the two compose files, and this report were changed. No UI, Gateway/Hub, publish, preview, or unrelated app behavior was intentionally changed.
