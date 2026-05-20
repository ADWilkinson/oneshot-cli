# Changelog

## 1.2.1 - 2026-05-20

- Refreshed the packaged `oneshot-ship` skill to match the current workflow runtime, policy packs, MCP surface, run ledger, and repo-instruction handling.
- Replaced stale router wording with first-class adaptive router language.

## 1.2.0 - 2026-05-20

- Added a durable run ledger under `~/.oneshot/runs` plus `oneshot runs`, `oneshot status`, and `oneshot eval`.
- Added workflow presets via `--workflow` and `oneshot workflow list/show` for ship, review, fix-ci, research, docs, and swarm-review modes.
- Added `.oneshot/policy.json` support with `oneshot policy init`, protected-path checks, required checks, approval-sensitive warnings, and secret-pattern gates.
- Added `oneshot mcp serve` so agent clients can call the public engine through MCP tools.
- Updated docs and packaged skill guidance for the public workflow-runtime surface.

## 1.1.0 - 2026-05-19

- Added a built-in adaptive work router that silently chooses Codex or Claude plus reasoning effort, context shape, execution style, and verification profile.
- Added `oneshot route "<task>" --json` for deterministic routing inspection without running a pipeline.
- Added `routing.enabled` config so installs can keep provider-first behavior by default or opt into invisible provider routing.
- Passed routed reasoning effort through to Claude via `claude --effort`, matching Codex's adaptive reasoning behavior.
- Added a packaged `route-work` skill for global agent configs.

## 1.0.0 - 2026-05-18

- Added a single-provider configuration model with `provider: "codex"` or `provider: "claude"`.
- Made Codex the default provider for fresh local config and `oneshot init`.
- Changed phase config to tune model/reasoning per phase while ignoring stale per-phase provider values.
- Updated `doctor` to check only the selected provider locally and remotely.
- Refreshed README, docs, and packaged skill guidance for the provider-first setup.

## 0.2.12 - 2026-05-17

- Added per-phase agent configuration via `phases.classify`, `phases.plan`, `phases.execute`, `phases.review`, `phases.deepReview`, and `phases.pr`.
- Each phase can now choose `claude` or `codex`, an exact model, and Codex reasoning effort where applicable.
- Kept legacy `claude` and `codex` config keys as backward-compatible defaults when `phases` is omitted.
- Updated `oneshot init`, README, docs site, and packaged skill docs for phase-agent configuration.
