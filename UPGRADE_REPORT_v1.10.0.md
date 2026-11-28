# App Builder — Pi SoloHost · v1.9.3 → v1.10.0 report

**Version:** 1.10.0 · **Default flag:** `ENGINEERING_TOOLKIT=shadow` (unchanged) · **Runtime deps:** `@octokit/rest`, `playwright`, `yaml` (unchanged, zero added)

## 1. Test counts
| | Command | Exit | Tests | Pass | Fail |
|---|---|---|---|---|---|
| Baseline v1.9.3 | `node --test tests/*.test.js` | 1 | 529 | 512 | 17 |
| After v1.10.0 | `npm ci && npm test` | 0 | 571 | 571 | 0 |

42 new tests: `tests/engineering-v110.test.js` (38), `tests/engineering-off-parity.test.js` (4).

## 2. Defects reproduced (evidence) → fixed
| ID | Defect (repro) | Status |
|---|---|---|
| D-00 | `ENGINEERING_TOOLKIT=on` integration never ran: `registerPipeline(ctx)` destructured `engineering` before `server.js` set `ctx.engineering` | FIXED (toolkit created first + lazy read) |
| D-01 | Shadow/validate could change source: DARE bridge passed `dryRun` that `runDare` ignored (preflight `applyAction` wrote); shadow errors swallowed | FIXED: real dry-run, source guard restores + `SHADOW_MUTATION` FAIL; test runs DARE dry-run + static validation on **every** template byte-identically |
| D-02 | Executor: `npm test` script bodies could run `node -e`; parent env (provider keys, Feedback token) copied to children; "executor busy" failures | FIXED: named commands, allowlisted env, FIFO queue, process-group kill — real-process tests |
| D-03 | Validation said PASS for apps that did not run (static only) | FIXED (flag on): boot + HTTP + Chromium QA; build fails if the app really fails |
| D-04 | Route scan found almost nothing in pathname-style servers; no client/server mismatch | FIXED: route intel v2; caught a real 404 in `hello-ai-app` |
| D-05 | Snapshot retention could delete baseline snapshots | FIXED: protected reasons + manifest hashes |
| Side | SoloHost `ports:` insert corrupting YAML; malformed fallback; 401→403; catalog `internalOnly`; improve patch dropped; stale compose tags | FIXED (were part of the 17 baseline failures) |

## 3. Benchmark (no AI, sandbox x64) — docs/engineering/BENCHMARK.md
- 17/17 bundled templates boot from a temp copy, `/health` 200, routes OK, browser QA PASS (sandbox-benchmark: Internet proxy → WARNING, honest).
- Seeded defects × 15 std templates: v1.9.3 detected 1 of 7 defect classes; v1.10.0 detects 7/7 (100%) and repairs the 4 deterministic classes 15/15 with 0 unrelated files touched.

## 4. Rule 0.4 — Feedback Hub
`src/config/loader.js` and `src/universal/mount-universal.js` are byte-identical to v1.9.3 (diff checked). Their token and hub id are masked in Builder logs, registry/tool output, evidence and API reports, and never reach child-process env (tests).

## 5. Test maintenance (owner review)
Three existing tests were updated, each with an in-file justification; none removed:
1. `templates-library`: 146 → 146 + 15 std templates (counts follow the shipped catalog; uniqueness still asserted).
2. `v189-improve-quality` look-alike path: path-safety now remaps an unambiguous look-alike without an extra AI round; the test still asserts correct paths and that the hallucinated path is never written.
3. `release-ai-pipeline`: accepts `let packageInfo` (ordering contract unchanged).

## 6. Not verified
- Raspberry Pi / ARM run → owner: `npm run verify:device` on the device (docs/engineering/DEVICE-REPORT.md).
- AI repair quality with a real provider (no key in sandbox).
- Flag `on` through a full real create job with a real model.

## 7. Owner actions
- Decide whether to switch the default to `on` after a Pi run (runtime checks cost ~5 s per validation on x64).
- There is no access-password gate on any API (by design per `src/http.js`); toolkit routes follow the same rule and only accept server-resolved project ids.
- Rebuild/publish the image so compose tags `1.10.0` resolve.

## 8. Changed files
New: `src/engineering/{evidence,guard,redact}.js`, `src/engineering/runtime/app-runner.js`, `src/engineering/diagnostics/imports.js`, `src/engineering/orchestrator/{provider-tiers,repair-loop}.js`, `src/engineering/registry/descriptors/runtime-tools.js`, `src/dare/{rules-v2,engine-v2}.js`, `scripts/{verify-device,engineering-benchmark}.mjs`, `tests/engineering-{v110,off-parity}.test.js`, `templates/hello-ai-app/{.env.example,public/made-by.png}`, `package-lock.json` (pins existing deps for `npm ci`), docs `BENCHMARK.md`, `DEVICE-REPORT.md`, this report.
Removed: `src/engineering/api.js` (unmounted, accepted a client `sourceDir`), empty `src/engineering/mcp/`.
Modified: see CHANGELOG 1.10.0 (engineering core, pipeline, upgrade engine, DARE, SoloHost, GitHub errors, snapshots, logger, API routes, Engineering panel UI + EN/VI strings, compose/Dockerfile/version).
