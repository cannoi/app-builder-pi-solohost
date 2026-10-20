# Architecture

Pi App Factory V1 is a single Node.js controller with clear modules.

- `src/api` HTTP routes
- `src/ai` provider-independent gateway
- `src/projects` isolated project trees and snapshots
- `src/jobs` persistent queue and pipeline
- `src/security` scanner and command policy
- `src/testing` static and node tests
- `src/docker` safe/power detection, runner, sandbox
- `src/github` repository + commit + release
- `src/release` notes and release records
- `src/storage` SQLite (`node:sqlite`)

Projects live in `./projects/{slug}/` with `source`, `tests`, `artifacts`, `logs`, `snapshots`, and `metadata`.

## 1.3.4 language and routing boundary
The visible Builder UI remains concise English. Dynamic AI responses use the language of the user's current message. The first message is preflight-routed by AI so informational questions do not create a project; clear build requests enter the normal Builder pipeline.

## User exports
Users can request a project ZIP or a SoloHost install-kit ZIP from chat. ZIP generation excludes `.env`, `.git`, and `node_modules` and exposes a direct download link in chat.

## Change Engine V2
- Flag: `CHANGE_ENGINE_V2=true` (default off → identical to 1.8.2).
- Modules: `src/engine/edits.js`, `prompts.js`, `agent-loop.js`, `checklist.js`, `visual-check.js`, `modify-engine.js`.
- Entry: `improveProject` when intent=MODIFY; optional `plan.edits` in `applyUpgrade`.
- Does not modify `patchPrompt` or `applySafeAiPatch`.
- Verification reuses static/node/security + checklist; vision is advisory only.
