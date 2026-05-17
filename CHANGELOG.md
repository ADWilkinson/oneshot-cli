# Changelog

## 0.2.12 - 2026-05-17

- Added per-phase agent configuration via `phases.classify`, `phases.plan`, `phases.execute`, `phases.review`, `phases.deepReview`, and `phases.pr`.
- Each phase can now choose `claude` or `codex`, an exact model, and Codex reasoning effort where applicable.
- Kept legacy `claude` and `codex` config keys as backward-compatible defaults when `phases` is omitted.
- Updated `oneshot init`, README, docs site, and packaged skill docs for phase-agent configuration.
