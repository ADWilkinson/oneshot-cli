# oneshot

One command to ship code. Give it a repo and a task, it plans, executes, reviews, and opens a PR.

```
laptop → your server → Claude (plan) → Codex (execute) → Codex (review) → Claude (PR)
```

Or run locally with `--local`, no SSH needed.

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

## The pipeline

1. **Validate**: checks the repo exists, fetches latest from origin
2. **Worktree**: creates a temp worktree from `origin/main`
3. **Classify**: chooses fast or deep review mode based on task complexity
4. **Plan**: Claude reads the codebase + `CLAUDE.md` conventions, outputs a plan
5. **Execute**: Codex implements the plan
6. **Draft PR**: Claude creates a branch, commits, pushes, and opens a draft PR
7. **Review**: Codex reviews the branch diff for bugs, types, and security
8. **Finalize**: pushes review fixes and marks the PR ready

Each run gets its own isolated `/tmp` worktree. Parallel runs on the same repo are safe.

## Usage

```bash
oneshot <repo> "<task>"                 # ship a task
oneshot <repo> <linear-url>            # ship from a Linear ticket
oneshot <repo> "<task>" --bg           # fire and forget
oneshot <repo> "<task>" --local        # run locally, no SSH
oneshot <repo> "<task>" --deep-review  # force exhaustive review
oneshot <repo> "<task>" --model sonnet # override Claude model
oneshot <repo> "<task>" --branch dev   # target a different branch
oneshot <repo> --dry-run               # validate only
oneshot init                           # configure
oneshot stats                          # recent runs + timing
```

| Flag | Short | Description |
|------|-------|-------------|
| `--model` | `-m` | Override Claude model |
| `--branch` | `-b` | Base branch (default: main) |
| `--deep-review` | | Force exhaustive review mode |
| `--local` | | Run locally instead of over SSH |
| `--bg` | | Run detached in background (returns PID + log path) |
| `--dry-run` | `-d` | Validate only |
| `--events-file` | | Mirror JSONL events to an additional file |
| `--help` | `-h` | Help |
| `--version` | `-v` | Version |

## Config

`~/.oneshot/config.json`, created by `oneshot init`:

```json
{
  "host": "user@100.x.x.x",
  "basePath": "~/projects",
  "anthropicApiKey": "sk-ant-...",
  "linearApiKey": "lin_api_...",
  "claude": { "model": "opus", "timeoutMinutes": 180 },
  "codex": {
    "model": "gpt-5.4-mini",
    "reasoningEffort": "xhigh",
    "reviewModel": "gpt-5.4-mini",
    "reviewReasoningEffort": "xhigh",
    "timeoutMinutes": 180
  },
  "stepTimeouts": {
    "planMinutes": 20,
    "executeMinutes": 60,
    "reviewMinutes": 20,
    "deepReviewMinutes": 20,
    "prMinutes": 20
  }
}
```

Only `host` is required for SSH runs. Local mode works with built-in defaults even without a config file.

## Structured events

Every run writes JSONL events to `/tmp/oneshot-<runId>.events.jsonl`. Pass `--events-file <path>` to mirror events to an additional file:

```bash
oneshot acme/api "fix bug" --local --events-file /tmp/run.events.jsonl
```

Events: `started`, `classified`, `step` (running/done/failed), `completed` (success/failed/dry-run).

## Safety

- **Worktree isolation**: each run gets its own `/tmp` worktree, parallel runs are safe
- **Branch sanitization**: rejects names containing `..`, leading `/`, or control characters
- **Path traversal protection**: worktree paths verified to be under `/tmp`
- **Atomic config writes**: saves use temp file + rename to prevent corruption
- **Graceful degradation**: if execute times out with partial changes, the draft PR is still created

## Customization

Drop a `CLAUDE.md` in any repo root to enforce conventions. oneshot passes it as context to both Claude and Codex.

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
