# oneshot

[![npm](https://img.shields.io/npm/v/oneshot-ship?color=black&label=npm)](https://www.npmjs.com/package/oneshot-ship)
[![license](https://img.shields.io/github/license/ADWilkinson/oneshot-cli?color=black)](LICENSE)
[![docs](https://img.shields.io/badge/docs-adwilkinson.github.io-black)](https://adwilkinson.github.io/oneshot-cli)

Ship code in one command. Repo + task in, PR out.

```
laptop → server → Claude (plan) → Codex (execute) → Codex (review) → Claude (PR)
```

Also runs locally with `--local`, no server needed.

## Install

Requires [Bun](https://bun.sh). macOS and Linux.

```bash
bun install -g oneshot-ship
```

## Quick start

```bash
oneshot init                                    # configure
oneshot my-org/my-app "fix the login timeout"   # ship
```

## How it works

oneshot runs an 8-step pipeline. Each run gets its own git worktree in `/tmp`, so your main branch is never touched. Parallel runs on the same repo are safe.

| Step | Engine | What it does |
|------|--------|-------------|
| 1. Validate | git | Checks the repo exists, fetches latest |
| 2. Worktree | git | Creates an isolated `/tmp` worktree from `origin/main` |
| 3. Classify | Claude Haiku | Picks fast or deep review mode based on task complexity |
| 4. Plan | Claude | Reads the codebase + `CLAUDE.md`, outputs an implementation plan |
| 5. Execute | Codex | Implements the plan |
| 6. Draft PR | Claude | Creates branch, commits, pushes, opens a draft PR |
| 7. Review | Codex | Reviews the diff for bugs, types, security. Fixes issues directly |
| 8. Finalize | Claude | Pushes review fixes, marks PR ready |

If execute times out with partial changes, the draft PR is still created so nothing is lost.

## Usage

```bash
oneshot <repo> "<task>"                 # ship a task
oneshot <repo> <linear-url>            # ship from a Linear ticket
oneshot <repo> "<task>" --bg           # fire and forget
oneshot <repo> "<task>" --local        # run locally, no SSH
oneshot <repo> "<task>" --mode deep    # skip classification and force deep mode
oneshot <repo> "<task>" --deep-review  # force exhaustive review
oneshot <repo> "<task>" --model sonnet # override Claude model
oneshot <repo> "<task>" --branch dev   # target a different branch
oneshot <repo> "<task>" --base-path /srv/workspaces  # override repo root for this run
oneshot <repo> --dry-run               # validate only
oneshot init                           # configure
oneshot stats                          # recent runs + timing
```

### Flags

| Flag | Short | Description |
|------|-------|-------------|
| `--model` | `-m` | Override Claude model |
| `--branch` | `-b` | Base branch (default: main) |
| `--base-path` | | Override the workspace path used to locate the repo |
| `--mode` | | Skip classification and force `fast` or `deep` mode |
| `--deep-review` | | Force exhaustive review mode |
| `--local` | | Run locally instead of over SSH |
| `--bg` | | Run detached in background (returns PID + log path) |
| `--dry-run` | `-d` | Validate only |
| `--events-file` | | Mirror JSONL events to an additional file |

## Prerequisites

**On your laptop:** [Bun](https://bun.sh), SSH access to your server

**On your server (or local machine with `--local`):**
- [Bun](https://bun.sh)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)
- [Codex CLI](https://github.com/openai/codex)
- [GitHub CLI](https://cli.github.com) (authenticated)
- `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` in env

## Configuration

`~/.oneshot/config.json`, created by `oneshot init`:

```json
{
  "host": "user@100.x.x.x",
  "basePath": "~/projects",
  "anthropicApiKey": "sk-ant-...",
  "linearApiKey": "lin_api_...",
  "claude": {
    "model": "opus",
    "timeoutMinutes": 180
  },
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
Remote SSH runs automatically forward the configured `basePath` to the server, so you do not need a duplicate `~/.oneshot/config.json` there unless you want one.

| Key | Required | Description |
|-----|----------|-------------|
| `host` | SSH only | SSH target, e.g. `user@192.168.1.10` |
| `basePath` | No | Where repos live. Default: `~/projects` |
| `anthropicApiKey` | No | Falls back to `ANTHROPIC_API_KEY` env var |
| `linearApiKey` | No | Enables Linear ticket integration |
| `claude.model` | No | Model for Plan, Classify, PR steps. Default: `opus` |
| `codex.model` | No | Model for Execute step. Default: `gpt-5.4-mini` |
| `codex.reasoningEffort` | No | Reasoning effort for execution. Default: `xhigh` |
| `codex.reviewModel` | No | Model for Review step. Default: same as `codex.model` |
| `codex.reviewReasoningEffort` | No | Reasoning effort for review. Default: same as `codex.reasoningEffort` |
| `stepTimeouts` | No | Per-step timeout overrides in minutes |

Repos on the server should live as `<org>/<repo>` under the base path:

```
~/projects/
  acme/api/
  acme/web/
```

## Linear integration

Pass a Linear URL instead of a task string:

```bash
oneshot acme/api https://linear.app/acme/issue/ENG-142
```

1. Fetches issue title, description, and comments via GraphQL
2. Uses ticket as context for the planning step
3. Uses the issue ID in the branch name (`oneshot/eng-142-...`)
4. Moves the ticket to "In Review" and comments the PR URL

Requires `linearApiKey` in config.

## Customization

**CLAUDE.md**: put one in any repo root. oneshot passes it to Claude and Codex at every step. Use it for coding standards, architecture decisions, test requirements.

**Prompt templates**: edit these to change pipeline behavior:

| File | Controls |
|------|----------|
| `prompts/plan.txt` | How Claude explores and plans |
| `prompts/execute.txt` | How Codex implements changes |
| `prompts/review.txt` | How Codex reviews the diff |
| `prompts/pr.txt` | How Claude creates the PR |

Templates use `{{variable}}` placeholders replaced at runtime.

The repo's `CLAUDE.md` is also supplied to the planning and execution steps, so the task string is the primary operator input, not the only context the agents receive.

## Events

Every run writes JSONL events to `/tmp/oneshot-<runId>.events.jsonl`. Use `--events-file <path>` to mirror to another file:

```bash
oneshot acme/api "fix bug" --local --events-file /tmp/run.events.jsonl
```

Events: `started`, `classified`, `step` (running/done/failed), `completed` (success/failed/dry-run).

## Agent skill

Works as an [Agent Skill](https://agentskills.io) in Claude Code, Codex CLI, Cursor, and other compatible agents.

```bash
npx skills add ADWilkinson/oneshot-cli
```

Or via [ClawHub](https://clawhub.ai):

```bash
clawhub install oneshot-ship
```

Agents pick it up automatically, or call `/oneshot-ship` directly.

## License

MIT
