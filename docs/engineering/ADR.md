# ADR — Engineering Toolkit

## ADR-001: Namespace `src/engineering` and API `/api/engineering/*`
Avoid collision with existing "Universal AI + Feedback".

## ADR-002: Feature flag `ENGINEERING_TOOLKIT=off|shadow|on` (default shadow)
Shadow records and exposes READ tools without changing CREATE/IMPROVE/UPGRADE write behavior.

## ADR-003: Adapters over rewrites
READ tools call `runAgentTools` for parity with Upgrade Workshop.

## ADR-004: No new runtime dependencies
Schema validation and executor use Node built-ins only.

## ADR-005: Feedback Hub secret rotation is OWNER ACTION
Skipped code changes to Feedback module per product request in this delivery.

## ADR-006: Mode Precedence & Unverified Pi Default Gate (v1.11.0)
Precedence is `env ENGINEERING_TOOLKIT > persisted Settings > shadow` (Compose files default `ENGINEERING_TOOLKIT: "auto"`). Unset fallback stays `shadow` until Pi budget is verified on real ARM hardware; `auto` promotes to `on` only when Chromium is installed, free RAM >= 1.5 GB, and host is not low-RAM ARM.

## ADR-007: Node `--permission` Runtime Isolation (v1.11.0)
Generated project code run via `node.start` / `node.check` executes with `--permission --allow-fs-read=<projectRoot,cwd,homeDir,node_modules>` and write access scoped strictly to the temp copy/home on `node.start`, blocking child process spawning by default (`--allow-child-process` disabled). Each run uses an isolated temp `HOME`, `TMPDIR`, and `npm_config_cache`. Residual risk: `npm.test` / `npm.build` run `npm` itself without Node `--permission`, though `scriptBodyAllowed()` blocks inline `node -e/-p/-r` and external absolute paths.

## ADR-008: Deterministic Acceptance Criteria Mapping (v1.11.0)
`plan.acceptance_checks` are mapped deterministically to verifiable checks (`http.health`, `browser.desktop`, `browser.mobile`). Unmapped or unrun criteria always stay `NOT_TESTED` — never guessed `PASS`.

## ADR-009: MCP Deferred (v1.11.0)
See `docs/engineering/MCP_DEFERRED.md`. Internal host-owned registry remains zero-dependency in-process.
