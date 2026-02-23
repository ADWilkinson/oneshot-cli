# oneshot

Ship code changes autonomously. Give it a repo and a task -- it plans, executes, reviews, and opens a PR. One shot.

## How it works

```
you (laptop) --ssh--> server (tailscale) --runs--> pipeline
```

1. **Plan** -- Claude reads the repo, understands conventions, and produces a step-by-step implementation plan
2. **Execute** -- Codex implements the plan, following the repo's CLAUDE.md conventions
3. **Review** -- Codex reviews its own changes for correctness, types, security, and style
4. **PR** -- Claude creates a branch, commits, pushes, and opens a pull request

Everything runs on your remote server via SSH. Your laptop is just a thin client that streams output back.

## Prerequisites

**On your laptop:**
- [Bun](https://bun.sh) runtime
- SSH access to your server (Tailscale recommended)

**On your server:**
- [Bun](https://bun.sh) runtime
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) (`claude`)
- [OpenAI Codex CLI](https://github.com/openai/codex) (`codex`)
- [GitHub CLI](https://cli.github.com) (`gh`) -- authenticated
- Git repos cloned in your workspace directory
- `ANTHROPIC_API_KEY` set in environment (or in config)
- `OPENAI_API_KEY` set in environment

## Install

```bash
# clone the repo
git clone https://github.com/ADWilkinson/oneshot-cli.git
cd oneshot-cli

# install deps
bun install

# link the binary globally
bun link
```

This makes the `oneshot` command available everywhere.

**On your server**, do the same:

```bash
git clone https://github.com/ADWilkinson/oneshot-cli.git
cd oneshot-cli
bun install
bun link
```

## Setup

Run the interactive setup:

```bash
oneshot init
```

This creates `~/.oneshot/config.json` with your settings:

```
oneshot init

configure your remote server (SSH target where Claude + Codex run):

  ssh host (e.g. user@100.x.x.x): myuser@100.89.113.63
  workspace path on server (~/projects): ~/projects

api keys (stored in ~/.oneshot/config.json):

  anthropic api key (optional, or set ANTHROPIC_API_KEY on server):
  linear api key (optional, for ticket integration):

model defaults:

  claude model (for planning + PR) (opus):
  claude timeout in minutes (180):
  codex model (for execution + review) (gpt-5.3-codex):
  codex reasoning effort (xhigh):
  codex timeout in minutes (180):
```

### Config reference

`~/.oneshot/config.json`:

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `host` | yes | -- | SSH target, e.g. `user@100.x.x.x` |
| `basePath` | no | `~/projects` | Root directory for repos on server |
| `anthropicApiKey` | no | -- | Anthropic API key (or set env var on server) |
| `linearApiKey` | no | -- | Linear API key for ticket integration |
| `claude.model` | no | `opus` | Claude model for planning and PR steps |
| `claude.timeoutMinutes` | no | `180` | Max time for Claude steps |
| `codex.model` | no | `gpt-5.3-codex` | Codex model for execution and review |
| `codex.reasoningEffort` | no | `xhigh` | Codex reasoning effort level |
| `codex.timeoutMinutes` | no | `180` | Max time for Codex steps |

### Server workspace layout

Your repos should be organized as `<org>/<repo>` under `basePath`:

```
~/projects/
  my-org/
    my-app/          # git repo
    my-api/          # git repo
  other-org/
    their-repo/      # git repo
```

## Usage

```bash
# basic -- describe the task
oneshot my-org/my-app "fix the login timeout bug"

# linear ticket -- fetches title, description, comments as context
oneshot my-org/my-app https://linear.app/team/issue/ABC-123/slug

# background -- fire and forget, runs on server
oneshot my-org/my-app "add rate limiting to the API" --bg

# dry run -- validate the repo exists on server without running
oneshot my-org/my-app --dry-run

# override model
oneshot my-org/my-app "refactor auth module" --model sonnet
```

### Flags

| Flag | Short | Description |
|------|-------|-------------|
| `--model` | `-m` | Override Claude model for this run |
| `--dry-run` | `-d` | Validate repo exists, don't run pipeline |
| `--bg` | | Run in background on server |
| `--help` | `-h` | Show help |
| `--version` | `-v` | Show version |

### Background mode

With `--bg`, the pipeline runs detached on your server. You get back a PID and log file path:

```
shipped to background on server
PID: 12345
LOG: /tmp/oneshot-1234567890.log

tail logs: ssh user@100.x.x.x "tail -f /tmp/oneshot-1234567890.log"
```

### Linear integration

Pass a Linear issue URL as the task and oneshot will:
1. Fetch the ticket title, description, and comments
2. Use that as full context for the AI pipeline
3. After PR creation, move the ticket to "In Review"
4. Add a comment on the ticket with the PR link

Requires `linearApiKey` in your config.

## How the pipeline works

Each run creates a temporary git worktree from `origin/main`, installs dependencies, and runs the 4-step pipeline. The worktree is cleaned up after completion.

**Step 1 - Validate**: Checks the repo exists on server and runs `git fetch origin`.

**Step 2 - Worktree**: Creates a detached worktree at `/tmp/oneshot-<id>`, auto-detects the package manager (bun/pnpm/yarn/npm), and installs dependencies.

**Step 3 - Plan (Claude)**: Reads the codebase including `CLAUDE.md` conventions. Produces a structured implementation plan: files to modify, approach, edge cases, validation commands.

**Step 4 - Execute (Codex)**: Implements the plan. Follows repo conventions. Runs validation (typecheck, lint, build) after changes.

**Step 5 - Review (Codex)**: Reviews all changes via `git diff`. Checks for correctness, type safety, security, and style. Fixes any issues found.

**Step 6 - PR (Claude)**: Creates a branch (`oneshot/<slug>-<timestamp>`), commits, pushes, and opens a PR with summary and test plan.

## Customization

### CLAUDE.md

If a repo has a `CLAUDE.md` file at its root, oneshot will read it and pass it as context to both Claude and Codex. This is how you enforce repo-specific conventions (import style, naming, patterns, etc).

### Prompt templates

The prompt templates live in `prompts/`:
- `plan.txt` -- planning step prompt
- `execute.txt` -- execution step prompt
- `review.txt` -- review step prompt
- `pr.txt` -- PR creation step prompt

You can edit these to customize the pipeline behavior.

## Troubleshooting

**"no config found"** -- Run `oneshot init` first.

**SSH connection fails** -- Make sure you can `ssh <host>` manually. Tailscale must be running on both machines.

**"command not found: oneshot" on server** -- Run `bun link` in the oneshot-cli directory on your server. Make sure `~/.bun/bin` is in your PATH.

**"command not found: claude/codex/gh"** -- Install the missing CLI tools on your server.

**Pipeline timeout** -- Increase `claude.timeoutMinutes` or `codex.timeoutMinutes` in your config.

## License

MIT
