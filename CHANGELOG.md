# Changelog

## 2.0.0 - 2026-06-14

Reimagined around fire-and-forget: detach a task, walk away, come back to a reviewed PR and a receipt that proves the contract ran.

- Added the proof-of-work **receipt**: every run (success, draft, or failure) writes `~/.oneshot/runs/<id>.receipt.json` capturing plan, contract steps, review outcome, policy verdict, the defaults the run had to assume, and a derived confidence rating. Inspect it with `oneshot receipt <run-id>` (text), `--json`, or `--html` for a self-contained artifact. Exposed over MCP as `oneshot_receipt`.
- Added a config-driven **notifier** so a detached run pings you when the receipt is ready. Backend-agnostic: set `notify.webhook` (POST the payload) and/or `notify.command` (run it with the payload on stdin and in `ONESHOT_NOTIFY_*` env). Best effort, never fails a run, gated by `onSuccess`/`onFailure`.
- Added a **GitHub Actions backend** via `oneshot gha init`: scaffolds a `workflow_dispatch` workflow that runs the same contract in CI and uploads the receipt as an artifact, giving durable detached runs to anyone without a dev box. Requires one provider API key in repo secrets (surfaced by the command).
- No existing flags changed. `--bg`, `--local`, SSH dispatch, the run ledger, policy packs, and workflow presets all behave as before.

## 1.2.3 - 2026-05-29

- Fixed prompt placeholder substitution so task descriptions, CLAUDE.md content, and plan output containing `$$`, `$&`, `$'`, or backtick-dollar are inserted literally instead of corrupting the prompt; every `{{placeholder}}` occurrence is now filled.
- Killed the full agent process tree on step timeout: the command now runs in its own process group so a timed-out `claude`/`codex` grandchild is signaled too, instead of orphaning and burning CPU after the parent exits.
- Honored the configured base branch when counting commits for the salvage snapshot, so runs on a non-`main` base no longer skip the safety push.
- Escaped the worktree path in the pipeline timeout probe and policy checks for consistency with every other git invocation.
- Added a 2-minute "still working" heartbeat around long, silent agent steps and raised the default plan timeout to 90 minutes for deep-mode runs on large monorepos.

## 1.2.2 - 2026-05-20

- Swept README, docs, and the packaged skill for stale pipeline phrasing and missing runtime command variants.
- Documented status-by-event-file, workflow inspection, policy path overrides, and worktree-root overrides consistently.

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
