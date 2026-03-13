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
2. **Worktree** -- creates a temp worktree from `origin/main`, installs deps
3. **Plan** -- Claude reads the codebase + `CLAUDE.md` conventions, outputs a plan
4. **Execute** -- Codex implements the plan
5. **Review** -- Codex reviews its own diff for bugs, types, security
6. **PR** -- Claude creates a branch, commits, pushes, opens a PR

Worktree is cleaned up after every run. Each run acquires a per-repo lockfile to prevent concurrent runs on the same repo.

## Usage

```bash
oneshot <repo> "<task>"                 # ship a task
oneshot <repo> <linear-url>            # fetch ticket as context
oneshot <repo> "<task>" --bg           # fire and forget
oneshot <repo> "<task>" --local        # run locally, no SSH
oneshot <repo> "<task>" --model sonnet # override model
oneshot <repo> --dry-run               # validate only
oneshot init                           # configure
```

| Flag | Short | Description |
|------|-------|-------------|
| `--model` | `-m` | Override Claude model |
| `--dry-run` | `-d` | Validate only |
| `--local` | | Run locally instead of over SSH |
| `--bg` | | Run in background (SSH mode only) |
| `--branch` | `-b` | Base branch (default: main) |
| `--events-file` | | Write JSONL events to a file for structured progress tracking |
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
  "codex": { "model": "gpt-5.3-codex", "reasoningEffort": "xhigh", "timeoutMinutes": 180 },
  "stepTimeouts": {
    "planMinutes": 20,
    "executeMinutes": 60,
    "reviewMinutes": 20,
    "prMinutes": 20
  }
}
```

Only `host` is required. Everything else has defaults.

## Structured events

Pass `--events-file <path>` to emit JSONL events for machine consumption:

```bash
oneshot my-org/my-app "fix bug" --local --events-file /tmp/run.events.jsonl
```

Events emitted: `started`, `step` (running/done/failed for each pipeline stage), `completed` (with PR URL or error). Designed for integration with bots and CI systems that need reliable progress tracking instead of log parsing.

## Safety

- **Repo lockfile**: prevents concurrent oneshot runs on the same repo (`~/.oneshot/locks/`)
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
