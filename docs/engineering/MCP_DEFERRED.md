# MCP Integration — Deferred to Future Release

Status: **DEFERRED** (not implemented in v1.11.0).

## Reason
All internal Engineering Toolkit tools run directly in-process via the host-owned registry (`src/engineering/registry/registry.js`) and controlled executor (`src/engineering/executor/exec.js`) without adding external MCP transport dependencies or protocol surface area. Zero new runtime dependencies remain in `package.json`.

## Revisit Criteria
Re-evaluate only when external third-party IDE/agent clients require stdio/SSE MCP tool exposure outside App Builder, with explicit authentication and per-tool capability scoping.
