# Builder simulation harness (mock AI, no real API calls)

`npm run sim` starts the REAL Builder server in a temp directory against a scripted mock AI (`mockai.mjs`) and runs 13+
scenarios: create (well-behaved / trailing-comma JSON / prose+fence / truncated / missing standard files), improve (good
change, syntax-broken proposal, hallucinated path, files:[], verify→feedback→retry, forced rollback, NEED_FILES + edits +
new file, Vietnamese request) and, when `SIM_ZIP=/path/app.zip` is set, an import with npm forced offline.
Exit code 1 when a scenario fails. Nothing touches your real `data/` folder.

The older single-purpose scripts (`drive.mjs`, `scen.mjs`, `imp.mjs`, `upg.mjs`, `improve.mjs`, `start.sh`) are kept for
manual experiments; they expect the temp directory `/tmp/sim` (set `SIM_DIR` for `mockai.mjs`).
Scenario file (`$SIM_DIR/scenario.json`) keys: `codeMode` (fenced|badjson|truncated), `omit` (files), `patch`, `patchSeq`+`seqId`,
`dumpKind` (dump full prompts of that kind), `delayMs`.
