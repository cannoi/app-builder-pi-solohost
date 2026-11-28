# Engineering Toolkit benchmark — v1.11.0

Reproduce: `npm run bench:engineering -- --ab --json bench.json` (no AI calls, no network).

## v1.11.0 Run (2026-11-24, Node 22.23.5, linux/x64, Chromium NOT_AVAILABLE)

In this sandbox Chromium is not installed, so browser steps report `NOT_TESTED` / `NOT_AVAILABLE` honestly. For the previous v1.10.0 Chromium run (`browser.desktop=PASS` on 16/17 templates and `WARNING` on `sandbox-benchmark`), see below.
This is a sandbox run (x64), **not** a Raspberry Pi run — see `DEVICE-REPORT.md` for the device procedure.

### A) Bundled templates: boot + HTTP runtime checks (non-mutating, temp copy, no Chromium)

| Template | Overall | runtime.start | http.health | http.routes | browser.desktop | ms |
|---|---|---|---|---|---|---|
| hello-ai-app | WARNING | PASS | PASS | PASS | NOT_TESTED | 708 |
| sandbox-benchmark | WARNING | PASS | PASS | PASS | NOT_TESTED | 556 |
| std-ai-agents | WARNING | PASS | PASS | PASS | NOT_TESTED | 494 |
| std-business-crm | WARNING | PASS | PASS | PASS | NOT_TESTED | 494 |
| std-chat-communication | WARNING | PASS | PASS | PASS | NOT_TESTED | 485 |
| std-cms-publishing | WARNING | PASS | PASS | PASS | NOT_TESTED | 481 |
| std-developer-api | WARNING | PASS | PASS | PASS | NOT_TESTED | 496 |
| std-ecommerce-marketplace | WARNING | PASS | PASS | PASS | NOT_TESTED | 482 |
| std-education-knowledge | WARNING | PASS | PASS | PASS | NOT_TESTED | 493 |
| std-erp-admin | WARNING | PASS | PASS | PASS | NOT_TESTED | 487 |
| std-finance-payment | WARNING | PASS | PASS | PASS | NOT_TESTED | 494 |
| std-games-entertainment | WARNING | PASS | PASS | PASS | NOT_TESTED | 485 |
| std-media-streaming | WARNING | PASS | PASS | PASS | NOT_TESTED | 472 |
| std-monitoring-analytics | WARNING | PASS | PASS | PASS | NOT_TESTED | 493 |
| std-productivity-pm | WARNING | PASS | PASS | PASS | NOT_TESTED | 477 |
| std-social-community | WARNING | PASS | PASS | PASS | NOT_TESTED | 465 |
| std-storage-files | WARNING | PASS | PASS | PASS | NOT_TESTED | 475 |

0 files mutated across all 17 templates (`mutatedFiles: 0`).

### B) Seeded defects on the 15 std-* templates — detection and deterministic repair

| Defect | v1.11.0 detected | v1.11.0 repaired without AI | unrelated files touched |
|---|---|---|---|
| fixed-port | 15/15 (100%) | 15/15 (100%) | 0 |
| bind-localhost | 15/15 (100%) | 15/15 (100%) | 0 |
| missing-esm-ext | 15/15 (100%) | 15/15 (100%) | 0 |
| undeclared-env | 15/15 (100%) | 15/15 (100%) | 0 |
| syntax-error | 15/15 (100%) | AI with evidence | — |
| ui-calls-missing-api | 15/15 (100%) | AI with evidence | — |
| crash-on-start | 15/15 (100%) | AI with evidence | — |

### C) Scripted A/B comparison (`ENGINEERING_TOOLKIT=off` vs `on`, N6)

Seeded on `std-business-crm` (with `.env.example` baseline); `syntax-error` receives a scripted fake-model repair, while `ui-calls-missing-api` and `crash-on-start` run with no live AI provider:

| Case | Expected healthy | `off` static status | `on` before | `on` after | `on` working claim | Truthful (`off` / `on`) |
|---|---|---|---|---|---|---|
| healthy-clean | true | passed | WARNING | WARNING | true | true / true |
| fixed-port | false | passed | FAIL | WARNING | true | false / true |
| bind-localhost | false | passed | FAIL | WARNING | true | false / true |
| syntax-error | false | passed | FAIL | WARNING | true | false / true |
| ui-calls-missing-api | false | passed | FAIL | FAIL | false | false / true |
| crash-on-start | false | passed | FAIL | FAIL | false | false / true |

Summary: `falsePositivesOff = 0`, `falsePositivesOn = 0`, `defectsCaughtOff = 0/5`, `defectsCaughtOrFixedOn = 5/5`.

Live AI provider repair evaluation (`npm run eval:ai-repair`): **NOT_TESTED** in sandbox (no API key configured — see `docs/engineering/AI-REPAIR-EVAL.md`).

---

## Historical v1.10.0 Chromium Run (2026-11-23, Node 22.23.5, linux/x64, `/usr/bin/chromium-browser`)

| Metric | Result |
|---|---|
| Bundled templates (runtime + browser QA) | 17/17 `runtime.start=PASS`, `http.health=PASS`, `http.routes=PASS`; 16/17 `browser.desktop=PASS`, `sandbox-benchmark` `browser.desktop=WARNING` (offline proxy 502) |
| Duration per template (with Chromium) | 3952–7211 ms (~4.8 s median) |
| Seeded defects × 15 `std-*` templates | 7/7 classes detected 15/15; 4 deterministic classes repaired 15/15 with 0 unrelated files |
