# Changelog

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
