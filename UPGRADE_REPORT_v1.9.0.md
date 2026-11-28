# UPGRADE REPORT — App Builder v1.9.0

VERSION: 1.9.0  
FLAG DEFAULT: shadow

## BASELINE (M0)
- Command: `node --test tests/*.test.js` after `npm install`
- Result: 477 tests, **445 pass / 32 fail**
- Failures include pre-existing cases (e.g. `v189-improve-quality`, `upgrade-publish-validation`)

## MILESTONES
| Milestone | Status |
|-----------|--------|
| M0 Baseline | PASS (recorded) |
| M1 Registry + READ tools | PASS (new unit tests) |
| M2 Controlled executor | PARTIAL (core + policy; not all call sites migrated) |
| M3 Project intelligence | PARTIAL (fingerprint only) |
| M4 Code diagnostics | NOT STARTED |
| M5 Validation pipeline | PARTIAL (status model only) |
| M6 Browser agent v2 | NOT STARTED |
| M7 Checkpoints v2 | NOT STARTED |
| M8 Orchestrator + context | PARTIAL (engineering-context load/save/migrate) |
| M9 DARE v2 | NOT STARTED |
| M10 Workflow integration | NOT STARTED (shadow does not change workflows) |
| M11 MCP | BLOCKED / deferred (optional, default OFF) |
| M12 Engineering UI | NOT STARTED |
| M13 Security audit doc | PARTIAL (ADR notes only; Feedback token not rotated — skipped per request) |
| M14 Full regression | PARTIAL |

## EVIDENCE
- `node --check` on new modules: OK
- `node --test tests/engineering-registry.test.js`: run in session after package
- Full suite baseline: 445/477 pass

## NOT VERIFIED
- Docker image build
- Live Chromium browser QA
- Live GitHub publish
- `flag=on` orchestrated CREATE/IMPROVE end-to-end

## OWNER ACTIONS
- Rotate Feedback Hub ingest token if still embedded in older images (not modified here by request)
- Align compose image tags to 1.9.0 when publishing

## FILES ADDED
- `src/engineering/**`
- `tests/engineering-registry.test.js`
- `docs/engineering/MILESTONES.md`, `docs/engineering/ADR.md`
- `UPGRADE_REPORT_v1.9.0.md`

## FILES CHANGED
- `src/server.js`, `src/api/routes.js`, `package.json`, `CHANGELOG.md`, `public/index.html` (version)
