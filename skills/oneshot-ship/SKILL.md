---
name: oneshot-ship
description: Ship code with oneshot CLI. One command that plans, executes, reviews, and opens a PR. Runs over SSH or locally. Use when the user wants to ship code changes, automate PRs, or run a coding pipeline with Claude and Codex.
license: MIT
metadata:
  author: ADWilkinson
  version: "0.2.0"
  repository: "https://github.com/ADWilkinson/oneshot-cli"
compatibility: Requires Bun, Claude Code CLI, Codex CLI, and GitHub CLI. SSH access to a server optional (can run locally with --local)
---

# oneshot CLI

Ship code with a single command. oneshot runs a full pipeline: plan (Claude) → execute (Codex) → review (Codex) → PR (Claude). Works over SSH to a remote server or locally with `--local`.

## When to use this skill

- User wants to ship a code change to a repository without manual coding
- User wants to automate the plan/implement/review/PR workflow
- User mentions "oneshot" or wants to delegate a coding task
- User wants to run a task on a remote server or locally

## Installation

```bash
bun install -g oneshot-ship
```

## Setup

Run `oneshot init` to configure SSH host, workspace path, API keys, and model preferences. Config is saved to `~/.oneshot/config.json`.

Repos on the server should live as `<org>/<repo>` under the workspace path:

```
~/projects/
  my-org/my-app/
  my-org/my-api/
```

### Server prerequisites

- [Bun](https://bun.sh)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)
- [Codex CLI](https://github.com/openai/codex)
- [GitHub CLI](https://cli.github.com) (authenticated)
- `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` in environment

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

## Pipeline

1. **Validate**: checks the repo exists, fetches latest from origin
2. **Worktree**: creates a temp git worktree from the target base branch
3. **Classify**: classifies the task as `fast` or `deep` via heuristics + LLM
4. **Plan**: Claude reads the codebase and CLAUDE.md conventions, outputs an implementation plan
5. **Execute**: Codex implements the plan. If it times out with partial changes, the pipeline continues
6. **Draft PR**: Claude creates a branch, commits, pushes, and opens a draft PR
7. **Review**: Codex reviews the diff. In `deep` mode it runs an exhaustive review across correctness, security, and code quality
8. **Finalize**: pushes review fixes and marks the PR ready

Worktree is cleaned up after every run.

## Configuration

`~/.oneshot/config.json`:

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

Only `host` is required for SSH runs. Local mode works without a config file.

## Flags

| Flag | Short | Description |
|------|-------|-------------|
| `--model` | `-m` | Override Claude model |
| `--branch` | `-b` | Base branch (default: main) |
| `--deep-review` | | Force exhaustive review mode |
| `--local` | | Run locally instead of over SSH |
| `--bg` | | Run in background, return PID + log path |
| `--dry-run` | `-d` | Validate only |
| `--events-file` | | Mirror JSONL events to an additional file |
| `--help` | `-h` | Help |
| `--version` | `-v` | Version |

## Customization

- Put a `CLAUDE.md` in any repo root. oneshot passes it to Claude and Codex at every step
- Edit `prompts/plan.txt`, `execute.txt`, `review.txt`, `pr.txt` to change pipeline behavior

## Tips

- Use `--bg` to fire and forget long tasks
- Linear integration moves tickets to "In Review" and comments the PR URL
- Per-step timeouts prevent runaway processes (plan 20m, execute 60m, review 20m, PR 20m)
- Worktree isolation means your main branch is never touched
- Task classification picks `fast` or `deep` mode automatically. Use `--deep-review` to force deep
- Duration estimates come from historical runs per repo (`~/.oneshot/history.json`)
