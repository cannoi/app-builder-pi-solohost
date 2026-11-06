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

## 1.8.33 native Agent loop
The Upgrade Workshop uses a provider-agnostic, host-controlled tool loop (`src/agent/tool-loop.js`). The existing AI Gateway / Provider Hub supplies model calls; Builder-owned inspection tools return bounded file and deployment evidence; per-project working memory stores the tool transcript; existing job events expose progress. The loop is capped at four iterations and sixteen tool calls, blocks repeated identical tool batches, and performs a final synthesis with tools disabled. File tools reject symlinks, project-root escapes, generated paths, secret files, and oversized reads. No arbitrary shell, network, Docker, or MCP execution is exposed.

The architecture borrows the useful Cline SDK separation of agent loop, host tools, events, and provider gateway without adding a second SDK/provider runtime. Build generation, Improve patching, DARE, snapshots, Preview, and Publish retain their existing execution paths.
