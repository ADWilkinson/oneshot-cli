# oneshot

One command to ship code. Give it a repo and a task -- it plans, executes, reviews, and opens a PR.

```
laptop --ssh--> your server --runs--> Claude (plan) -> Codex (execute) -> Codex (review) -> Claude (PR)
```

Or run locally with `--local` -- no SSH needed.

**[Read the docs](https://adwilkinson.github.io/oneshot-cli)**

## Install

```bash
bun install -g oneshot-ship
```

## Quick start

```bash
oneshot init                                    # configure
oneshot my-org/my-app "fix the login timeout"   # ship
```

## What it does

1. **Validate** -- checks the repo exists, fetches latest from origin
2. **Worktree** -- creates a temp worktree from `origin/main`
3. **Classify** -- chooses a fast or deep review mode based on task complexity
4. **Plan** -- Claude reads the codebase + `CLAUDE.md` conventions, outputs a plan
5. **Execute** -- Codex implements the plan
6. **Draft PR** -- Claude creates a branch, commits, pushes, and opens a draft PR so work is preserved
7. **Review** -- Codex reviews the branch diff for bugs, types, and security
8. **Finalize** -- pushes any review fixes and marks the PR ready

Worktree is cleaned up after every run. Parallel runs on the same repo are safe -- each gets its own worktree, and `gitRetry` handles any brief contention on the shared `.git` directory.

## Usage

```bash
oneshot <repo> "<task>"                 # ship a task
oneshot <repo> <linear-url>            # fetch ticket as context
oneshot <repo> "<task>" --bg           # fire and forget
oneshot <repo> "<task>" --local        # run locally, no SSH
oneshot <repo> "<task>" --deep-review  # force exhaustive review mode
oneshot <repo> "<task>" --model sonnet # override model
oneshot <repo> --dry-run               # validate only
oneshot init                           # configure
oneshot stats                          # recent runs + averages
```

| Flag | Short | Description |
|------|-------|-------------|
| `--model` | `-m` | Override Claude model |
| `--deep-review` | | Force deep review mode |
| `--dry-run` | `-d` | Validate only |
| `--local` | | Run locally instead of over SSH |
| `--bg` | | Run detached in background and print PID + log path |
| `--branch` | `-b` | Base branch (default: main) |
| `--events-file` | | Mirror JSONL events to an additional file |
| `--help` | `-h` | Help |
| `--version` | `-v` | Version |

## Config

`~/.oneshot/config.json` -- created by `oneshot init`:

```json
{
  "host": "user@100.x.x.x",
  "basePath": "~/projects",
  "anthropicApiKey": "sk-ant-...",
  "linearApiKey": "lin_api_...",
  "claude": { "model": "opus", "timeoutMinutes": 180 },
  "codex": { "model": "gpt-5.4-mini", "reasoningEffort": "xhigh", "timeoutMinutes": 180 },
  "stepTimeouts": {
    "planMinutes": 20,
    "executeMinutes": 60,
    "reviewMinutes": 20,
    "prMinutes": 20
  }
}
```

Only `host` is required for SSH runs. Local mode can fall back to built-in defaults even if `~/.oneshot/config.json` does not exist yet.

## Structured events

Every run writes JSONL events to `/tmp/oneshot-<runId>.events.jsonl` so `oneshot stats` can inspect recent history. Pass `--events-file <path>` to mirror the same events to an additional file for machine consumption:

```bash
oneshot my-org/my-app "fix bug" --local --events-file /tmp/run.events.jsonl
```

Events emitted: `started`, `step` (running/done/failed for each pipeline stage), `classified`, `completed` (with a terminal result of `success`, `failed`, or `dry-run`). Designed for integration with bots and CI systems that need reliable progress tracking instead of log parsing.

## Safety

- **Worktree isolation**: each run gets its own `/tmp` worktree; parallel runs on the same repo are safe
- **Branch sanitization**: rejects branch names containing `..`, leading `/`, or control characters
- **Path traversal protection**: worktree paths are verified to be under `/tmp`
- **Atomic config writes**: config saves use temp file + rename to prevent corruption

## Customization

Drop a `CLAUDE.md` in any repo root to enforce conventions -- oneshot passes it as context to both Claude and Codex.

Edit `prompts/plan.txt`, `execute.txt`, `review.txt`, `pr.txt` to change pipeline behavior.

## Agent skill

Available as an [Agent Skill](https://agentskills.io) for Claude Code, Codex CLI, Cursor, and other skills-compatible agents.

```bash
npx skills add ADWilkinson/oneshot-cli
```

Or via [ClawHub](https://clawhub.ai):

```bash
clawhub install oneshot-ship
```

## License

MIT
