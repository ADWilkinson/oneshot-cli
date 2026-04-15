# Code Quality Cleanup Assessment

Scope: oneshot-cli (~2400 LOC, single-binary Bun CLI). One combined PR covering all 8 areas because of repo size.

## 1. Dedup / DRY

Applied (high confidence):

- New `src/steps/shared.ts` extracts: `loadPromptTemplate`, `readClaudeMd`, `getPluginFlag`, `codexEffortConfig`, review model + effort helpers. Previously duplicated across `plan.ts`, `execute.ts`, `pr.ts`, `review.ts`.
- Unified CLI arg builder: `buildRemoteCommandParts` and `buildLocalChildArgs` were near-identical (differ only in whether each value is shell-escaped). Collapsed to a single `buildPipelineArgs({ escape })` helper.

Skipped:

- `formatTime` exists in both `log.ts` and `stats.ts` but formats differently (ms vs seconds). Intentional.
- ANSI color constants in `log.ts` and `stats.ts` — below the 3-line threshold and stats is the only other consumer.

## 2. Type consolidation

No duplicated type definitions. No action.

## 3. Dead code

Ran `knip`. Reviewed flagged items:

- `ONESHOT_STEPS`, `OneshotStep`, `getStepShort`: the contract file `pipeline-steps.ts` is the documented source-of-truth that `oneshot-bot/src/services/oneshot-contract.ts` mirrors. KEEP.
- Event type exports (`StartedEvent`, `StepEvent`, `CompletedEvent`, `ClassifiedEvent`, `OneshotEvent`): JSONL wire contract — the bot parses these files. Package publishes `src/**/*.ts` so these are public surface. KEEP.
- `ExecResult`, `ErrorCode`, `StepTimeoutKey`: published helper types. KEEP.
- `docs/assets/script.js`: static docs site asset. KEEP.

No action — all flagged exports are load-bearing for the shipped source-published contract.

## 4. Circular dependencies

`madge --circular src/cli.ts` → none. No action.

## 5. Weak types

- Zero `any`, `as any`, `@ts-ignore`, or `@ts-expect-error` in source. Strict mode already on.
- `stats.ts` had `e.step!`, `e.label!`, `e.elapsed!` after a predicate filter. Replaced with a proper type guard (`hasStepDetails`) so non-null assertions are gone and the narrowed type is visible.

## 6. Defensive try/catch

Reviewed every catch. All remaining ones are legitimate boundaries:

- `pipeline.ts` history read/write, worktree teardown, Linear update, diffstat — best-effort, non-fatal.
- `events.ts` file writes — warns once per path, suppresses thereafter.
- `cli.ts` top-level CLI error handler.
- `exec.ts` `killProcessTree` — process already dead.
- `config.ts` JSON parse — wraps with path context.
- `classify.ts` "fail safe" to `deep` — documented fallback when the haiku call fails.
- `version.ts` package.json read — returns `"0.0.0"` rather than crashing the CLI at import time.
- `stats.ts` — tolerates corrupted `/tmp` files.
- `pr.ts` `getDiffStats` — display-only, non-fatal.

No action.

## 7. Legacy / deprecated

None. No action.

## 8. AI slop / comments

Trimmed a few restating comments:

- `pipeline.ts`: "Push review fixes (if any) and mark PR as ready" (restates code).
- `pipeline.ts`: "Stage and commit the review fixes" (restates).
- `pr.ts`: "Check if review made any changes" (restates).
- `pr.ts`: "Mark the PR as ready (remove draft status)" (restates).

Kept every real WHY comment: graceful-degradation note, rebase-race commentary, pipeline-steps contract header, plugin-dir JSDoc.

## Verification

- `bun run typecheck` — clean
- `bun test` — 16 pass
- `bun run build` — succeeds
