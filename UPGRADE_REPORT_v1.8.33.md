# Upgrade Report — App Builder v1.8.33

## Objective

Apply the strongest useful Cline SDK architectural ideas to the existing App Builder without replacing its AI Gateway, Provider Hub, Builder UI, or established quality and release pipeline. This is a native, provider-agnostic implementation, not a Cline SDK integration.

## Cline SDK advantages relevant to this Builder

The current Cline SDK separates a reusable agent loop (`@cline/agents`) from its Node orchestration/session layer (`@cline/core`) and provider layer (`@cline/llms`). Its useful ideas include iterative tool execution, event streaming, session continuity, composable tools, lifecycle hooks, provider independence, and bounded runtime orchestration. The public SDK documentation also requires Node.js 22+ and offers both a lightweight loop and a full harness.

For this Builder, the highest-value subset is:

1. Agent loop: model requests evidence → Builder executes a safe tool → results return to the model → repeat until a final plan.
2. Host-owned tools: the Builder, not the model, executes file inspection and enforces the allowlist.
3. Persistent working memory: keep the task, tool transcript, evidence, and next step outside the model context.
4. Event visibility: report inspection progress using the existing job event channel.
5. Loop safety: hard iteration/tool limits and repeated-action detection to avoid runaway or no-progress loops.
6. Provider independence: continue routing every model request through the existing AI Gateway / Provider Hub.

## Implemented in 1.8.33

- Added `src/agent/tool-loop.js`, a reusable, bounded tool-calling loop.
- Integrated the loop into `diagnoseUpgradeRequest()` / Upgrade Workshop.
- The model can request multiple rounds of source inspection rather than being limited to one tool round.
- Limits: maximum 4 model/tool iterations, maximum 16 total tool calls, maximum 6 actions per iteration; limits are clamped in code.
- Duplicate identical tool batches are blocked. A final synthesis request is made with tool execution disabled.
- Tool transcripts and evidence are persisted in `agent-working-memory.json` through the existing project metadata store.
- Agent progress is emitted through existing job events; no new UI panel or separate session system was introduced.
- Added `inspect_package` for package metadata without exposing arbitrary file-system or process execution.
- Agent file reads now reject symlinks, project-root escapes, non-regular files, and files over the per-read byte cap.
- Added focused tests for multi-round tool execution, repeated-action blocking, memory persistence, package inspection, and symlink escape rejection.

## Intentionally not implemented

- `@cline/sdk` / `@cline/core` / `@cline/agents` dependency: not added. The existing Builder already has its own AI Gateway, working memory, snapshots, DARE, patch validation, and job lifecycle. Adding a second provider/session/tool runtime before a measured need would duplicate core responsibilities and increase package weight and integration risk.
- MCP, arbitrary shell/terminal execution, web browsing, Docker control, plugin auto-loading, scheduled agents, multi-agent/subagent teams, remote sessions: not added. They expand security, operational, and dependency scope beyond the safe file-inspection loop required here.
- Build generation and Improve repair algorithms were not rewritten. They retain their existing multi-phase generation, targeted file selection, patch validation, and bounded correction cycles.
- No UI redesign or translation catalog change was needed; existing English/Vietnamese UI and chat language rules remain authoritative.

## Files changed

- `src/agent/tool-loop.js` — new reusable Agent loop.
- `src/ai/agent-tools.js` — safe package inspection and hardened file reads.
- `src/upgrade/engine.js` — multi-round tool-loop integration and existing job progress events.
- `tests/agent-tool-loop.test.js` — new regression tests.
- `package.json`, `package-lock.json` — version 1.8.33 only; no dependency additions.
- `CHANGELOG.md` — release notes.
- `UPGRADE_REPORT_v1.8.33.md` — this report.

## Preserved

AI Gateway and Provider Hub; user-selected provider/model behavior; Build/Upgrade/Publish separation; DARE; checkpoints/snapshots/rollback; Improve patch pipeline; multi-phase generation; Preview/Sandbox/Playwright; GitHub/GHCR publishing; SoloHost compose/config validation; Feedback Hub; Template Library; existing UI and i18n.

## Validation

- `node --check` for changed JavaScript modules: PASS.
- `tests/agent-tool-loop.test.js`: 4/4 PASS.
- `tests/upgrade-session.test.js`: PASS.
- `tests/agent-v3-architecture.test.js`: could not load because `yaml` is not installed in this offline packaging environment. This is an environment/dependency availability failure, not a failing assertion.
- Full `npm test`: NOT RUN; dependencies are not installed and offline package cache does not contain the required `yaml` dependency.
- Docker build, browser E2E, and live SoloHost installation: NOT VERIFIED in this environment.

## Compatibility and risk

No new runtime dependency and no Cline package were added. Package version is 1.8.33. The new loop is isolated to Upgrade Workshop; it does not change the Build or Publish pipeline. Tool access remains limited to the existing file-inspection allowlist plus package metadata inspection. No shell, network, Docker socket, secrets, or arbitrary code execution is exposed to the agent.
