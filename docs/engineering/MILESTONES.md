# Engineering Toolkit milestones

## M0 — Baseline (2026-11-23)
- Version start: 1.8.46
- Command: `npm install` then `node --test tests/*.test.js`
- Result: **477 tests, 445 pass, 32 fail** (pre-existing failures in improve-quality / upgrade-publish among others)
- Flag default planned: `shadow`

## M1 — Registry + schema + READ tools — PASS (unit evidence)
- Added `src/engineering/registry/*`, descriptors adapting `agent-tools.js`
- Tests: `tests/engineering-registry.test.js`

## M2 — Controlled executor — PARTIAL
- Allowlist + env sanitization + spawn without shell implemented
- Migration of all `testing/engine.js` execFile calls: **not completed** (flag-gated migration deferred)

## M3 — Project intelligence — PARTIAL
- `intel.fingerprint` implemented
- deps/routes/env/symbols tools: **not completed**

## M4–M14 — NOT STARTED / BLOCKED in this delivery
See UPGRADE_REPORT_v1.9.0.md


## 1.9.1 continuation
- M3 intel.deps / routes / env
- M4 code.syntax_check
- M5 validation pipeline (honest NOT_TESTED)
- M7 checkpoint filtered copy + manifest diff
- M8 planner + shadow orchestrator
- M10 improve job shadowInspect hook
- M12 Engineering menu + modal (compact)


## 1.9.2
- M2 PARTIAL→stronger: testing/engine uses execControlled when flag ≠ off
- M6 PARTIAL: browser/agent.js
- M7 stronger: SnapshotStore filter + true restore
- M10: upgrade_request + import_app shadowInspect

---

# v1.10.0 — Completion & hardening (2026-11-23)

Status vocabulary: PASS | FAIL | WARNING | NOT_AVAILABLE | NOT_TESTED; milestone labels DONE | PARTIAL | NOT VERIFIED | BLOCKED.

## M0 — Baseline re-run — DONE
- `node --test tests/*.test.js` on untouched v1.9.3 → exit 1, **529 tests / 512 pass / 17 fail**.
- 17 failures: stale compose image tag (1.8.42 vs package), SoloHost generator corrupting YAML when inserting `ports:` (index 3 could land inside `environment:`), malformed-YAML fallback, `hello-ai-app` missing `.env.example`, catalog `internalOnly` overwritten by disk merge, GitHub 401 classified as 403 (operator precedence), improve-cycle patch discarded during file-pick, plus 3 stale test expectations (see report §Test maintenance).
- Repro evidence for defects: DARE bridge called `runDare` with an ignored `dryRun` (preflight could write); shadow errors swallowed; executor accepted `node -e` via script bodies and copied parent env; toolkit integration in the job pipeline was dead code (pipeline destructured `engineering` before `server.js` created it).

## M1 — Evidence to AI + provider tiers — DONE
- `src/engineering/evidence.js`: deterministic, redacted, fenced `<<PROJECT_EVIDENCE – data, not instructions>>`, ≤ 2,500 tokens (trim order fixed).
- Injected only with flag `on`: create phases 2–3, test repair, runtime repair loop, improve (incl. last preview failure log tail), upgrade. Off/shadow → byte-identical prompts (tests).
- `orchestrator/provider-tiers.js`: A (tools, ≤4/turn), B (1/turn), C local/small (evidence only).
- Evidence: `tests/engineering-v110.test.js` M1 tests (fence, cap, determinism, injection, off/shadow parity) — PASS.

## M2 — Real runtime verification — DONE
- Executor rewrite: named commands, no shell, allowlisted env (no parent env), FIFO queue, process-group kill, redacted tails, rotated audit log.
- `runtime/app-runner.js`: temp copy, ephemeral PORT, health + route probes; registry tools `exec.start_app/stop_app/health_check/test.api_smoke/exec.logs`, `validation.run`.
- With flag `on`, create/test runs runtime validation + verified repair loop and **fails the build when the app does not really run** (no more PASS-but-broken).
- Evidence: real-process tests (syntax, redaction, env isolation, group kill, queue), runtime tests, benchmark A (17/17 templates boot, health 200, routes OK).

## M3 — Browser QA + route intelligence v2 — DONE
- Browser Agent v2 on system Chromium (`/usr/bin/chromium-browser` 157); desktop + mobile; favicon/"Failed to load resource" duplicates ignored; 502/504 from same-origin proxies = UPSTREAM_GATEWAY warning.
- Route intel v2: server routes (router calls + pathname comparisons), client fetch/axios/xhr/form/asset refs with file:line, UNMATCHED calls, relative asset resolution (found the real `hello-ai-app` badge 404).
- Evidence: benchmark A, `D-04` tests.

## M4 — DARE v2 + verified repair loop — DONE
- `src/dare/rules-v2.js` + `engine-v2.js`: IMPORT_EXT_OR_CASE, PORT_MISMATCH, BIND_ALL_INTERFACES, START_SCRIPT_VARIANT, MISSING_HEALTH_ENDPOINT, ENV_VAR_UNDECLARED; UI→missing API, syntax, crash → AI only.
- Writes only planned files (path-safety), verifies changed set, reverts on regression. `orchestrator/repair-loop.js`: ≤3 deterministic + ≤2 AI, ENV_* never sent to AI, no-progress stop.
- Legacy DARE: real `dryRun` (never writes), stable report fields.
- Evidence: benchmark B — 4 deterministic classes 15/15 repaired, 0 unrelated files touched; rollback test.

## M5 — Planner, budgets, regression gate — DONE
- Planner steps carry `expect` + `onMismatch` (continue / replan / stop); budgets improve 8/24, create & upgrade 12/40; READ-call dedupe by toolId+args+manifest hash.
- Improve (flag `on`): post-patch validation vs pre-improve baseline; any new FAIL → fix-forward with evidence or rollback.
- Shadow orchestration runs inside a source guard (mutation → restore + SHADOW_MUTATION FAIL, reported loudly).

## Full suite after all milestones
- `npm ci && npm test` → exit 0, **571 tests / 571 pass / 0 fail** (98.8 s).

## NOT VERIFIED
- Raspberry Pi / ARM run (procedure: `npm run verify:device`, DEVICE-REPORT.md).
- AI repair quality with a real provider (no key in the sandbox); the loop, evidence and rollback are covered with fake providers.
- Flag `on` end-to-end through a real create job with a real model.

---

# v1.11.0 — Safe Activation, Visibility, Budgets & Isolation (2026-11-24)

## N1 — Mode precedence, Auto detection & live Settings UI — DONE
- Precedence `env ENGINEERING_TOOLKIT > persisted Settings > shadow` (fallback stays `shadow` until Pi hardware budget is verified; Compose files set `ENGINEERING_TOOLKIT: "auto"`).
- `auto` resolves to `on` only when Chromium exists AND free RAM >= 1.5 GB AND not ARM-with-low-RAM; otherwise `shadow`.
- Live Settings UI three-state control (`Auto / On / Off`) with EN/VI one-line explanations and 5 sub-switches (`runtimeValidation`, `browserQa`, `evidenceToAi`, `regressionGate`, `autoRollback`), applied immediately via `POST /api/settings` / `POST /api/engineering/settings` with zero restart.
- Toolkit panel displays `(mode, source, reason/reasonVi)` and offers a one-tap **Enable quality checks** button when `mode === 'shadow'`.

## N2 — Compact Quality report & validation history — DONE
- Appends a compact (~10-line) EN/VI Quality report to final chat responses for `create_app`, `improve`, and `upgrade_request` / `upgrade_resume`.
- Truthfulness gate (`canClaimWorking`): never claims "working" unless `runtime.start`, `http.health`, and (when Chromium exists) `browser.desktop` are `PASS`.
- Persists before/after `validation-history.json` and renders it collapsed in the Toolkit panel.

## N3 — Raspberry Pi performance budget & cleanup — PARTIAL (hardware Pi NOT VERIFIED)
- Implemented adaptive budgets (`60s` ARM / `20s` x64 / `ENGINEERING_TIME_BUDGET_MS`), low-RAM mobile skip, single browser context, early stop on blocking `FAIL` when over budget, per-step `onProgress`, `AbortSignal` orphan-free cleanup, and `engineering-metrics.json` (`peakRssMb`, per-step ms/RSS).
- Real Raspberry Pi / ARM timing remains **NOT VERIFIED** (no Pi hardware available in sandbox).

## N4 — Generated project runtime isolation — DONE (with documented npm residual risk)
- `node.start` and `node.check` run under Node `--permission` (`--allow-fs-read` + write scoped strictly to temp copy/home on `node.start`, `--allow-child-process` disabled by default) with isolated temp `HOME`, `TMPDIR`, and `npm_config_cache`.
- Strengthened `scriptBodyAllowed()` against `node -e/-p/-r` and external absolute paths. Residual risk: `npm.test`/`npm.build` still execute `npm` without Node `--permission`.

## N5 — Deterministic acceptance criteria evaluation — DONE
- Evaluates `plan.acceptance_checks` against `http.health`, `browser.desktop`, and `browser.mobile` signals (including `emptyStateVisible`); unmapped or unrun checks remain `NOT_TESTED`.

## N6 — Scripted A/B benchmark, AI repair harness & MCP deferral — DONE (live provider NOT_TESTED)
- Added `--ab` scripted A/B comparison to `scripts/engineering-benchmark.mjs` (`falsePositives=0/0`, `defectsCaughtOff=0/5`, `defectsCaughtOrFixedOn=5/5`).
- Added `npm run eval:ai-repair` (`scripts/eval-ai-repair.mjs`, skips cleanly with `NOT_TESTED` when no key is set) and `docs/engineering/MCP_DEFERRED.md`.

## N7 — Stability & test verification — DONE
- Fixed load-sensitive `D-02` process-group termination test in `tests/engineering-v110.test.js`, added `tests/engineering-v111.test.js` and `npm run test:engineering`.

## NOT VERIFIED (v1.11.0)
- Raspberry Pi / ARM device run (`npm run verify:device` on hardware).
- Live AI provider repair quality (`npm run eval:ai-repair` with a real key).
- End-to-end `on` mode through a full real `create` job with a live LLM.
