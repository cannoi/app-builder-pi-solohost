# UPGRADE REPORT — App Builder v1.9.1

VERSION: 1.9.1  
FLAG DEFAULT: shadow

## BASELINE (from 1.9.0 / M0)
477 tests · 445 pass / 32 fail (pre-existing)

## NEW TESTS (this delivery)
- tests/engineering-registry.test.js — 6/6 PASS
- tests/engineering-pipeline.test.js — 5/5 PASS (validation, planner, shadow, checkpoint, intel)

## MILESTONES
| Milestone | Status |
|-----------|--------|
| M0 Baseline | PASS (prior) |
| M1 Registry + READ | PASS |
| M2 Executor | PARTIAL (policy+spawn; testing/engine migration still open) |
| M3 Intelligence | PASS (fingerprint, deps, routes, env) |
| M4 Diagnostics | PARTIAL (syntax_check only) |
| M5 Validation pipeline | PARTIAL (core steps + honest NOT_TESTED) |
| M6 Browser v2 | NOT STARTED |
| M7 Checkpoints v2 | PARTIAL (filtered copy + manifest + diff; not wired to SnapshotStore rollback API) |
| M8 Orchestrator | PARTIAL (planner + shadow loop; flag=on full loop not shipped) |
| M9 DARE v2 | NOT STARTED |
| M10 Workflow | PARTIAL (improve shadowInspect only) |
| M11 MCP | BLOCKED / deferred |
| M12 UI | PARTIAL (⋯ Engineering modal compact) |
| M13 Security audit | PARTIAL |
| M14 Full regression | NOT VERIFIED (full suite not re-run end-to-end this session) |

## NOT VERIFIED
Docker image build, Chromium E2E, live GitHub, flag=on write orchestration

## SKIPPED
Feedback Hub secret changes (per product request)

## FILES ADDED
src/engineering/intel/{deps,routes,env}.js
src/engineering/diagnostics/syntax.js
src/engineering/validation/pipeline.js
src/engineering/checkpoints/store.js
src/engineering/orchestrator/{planner,orchestrator}.js
src/engineering/hooks.js
public/engineering.js, public/engineering.css
tests/engineering-pipeline.test.js

## FILES CHANGED
src/engineering/index.js, src/api/routes.js, src/jobs/pipeline.js, public/index.html, public/app.js, package.json, CHANGELOG.md
