# oneshot

One command to ship code. Give it a repo and a task -- it plans, executes, reviews, and opens a PR.

```
laptop --ssh--> your server --runs--> Claude (plan) -> Codex (execute) -> Codex (review) -> Claude (PR)
```

Or run locally with `--local` -- no SSH needed.

## Quick start

### 1. Prerequisites

**Laptop:** [Bun](https://bun.sh), SSH access to your server

**Server:** [Bun](https://bun.sh), [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex CLI](https://github.com/openai/codex), [GitHub CLI](https://cli.github.com) (authenticated), `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` in environment

### 2. Install (both laptop and server)

```bash
bun install -g oneshot-ship
```

Or from source:

```bash
git clone https://github.com/ADWilkinson/oneshot-cli.git
cd oneshot-cli && bun install && bun link
```

### 3. Configure

```bash
oneshot init
```

Walks you through setting your SSH host, workspace path, API keys, and model preferences. Saves to `~/.oneshot/config.json`.

Your repos on the server should be organized as `<org>/<repo>` under your workspace path:

```
~/projects/
  my-org/my-app/
  my-org/my-api/
```

### 4. Ship

```bash
oneshot my-org/my-app "fix the login timeout bug"
```

## Usage

```bash
oneshot <repo> "<task>" [flags]
oneshot <repo> <linear-url> [flags]    # fetches ticket as context, updates status after PR
oneshot <repo> "<task>" --bg           # fire and forget, runs detached on server
oneshot <repo> --dry-run               # validate repo exists without running
oneshot <repo> "<task>" --model sonnet # override claude model
oneshot <repo> "<task>" --local        # run locally, no SSH
oneshot init                           # configure ~/.oneshot/config.json
```

| Flag | Short | Description |
|------|-------|-------------|
| `--model` | `-m` | Override Claude model |
| `--dry-run` | `-d` | Validate only |
| `--local` | | Run locally instead of over SSH |
| `--bg` | | Run in background (SSH mode only) |
| `--help` | `-h` | Help |
| `--version` | `-v` | Version |

## What it does

1. **Validate** -- checks the repo exists, fetches latest from origin
2. **Worktree** -- creates a temp worktree from `origin/main`, installs deps (auto-detects bun/pnpm/yarn/npm)
3. **Plan** -- Claude reads the codebase + `CLAUDE.md` conventions, outputs an implementation plan
4. **Execute** -- Codex implements the plan
5. **Review** -- Codex reviews its own diff for bugs, types, security
6. **PR** -- Claude creates a branch, commits, pushes, opens a PR

Worktree is cleaned up after every run.

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

## Customization

Drop a `CLAUDE.md` in any repo root to enforce conventions -- oneshot passes it as context to both Claude and Codex.

Edit `prompts/plan.txt`, `execute.txt`, `review.txt`, `pr.txt` to change pipeline behavior.

## Agent skill

oneshot CLI is available as an [Agent Skill](https://agentskills.io) for Claude Code, Codex CLI, Cursor, and other skills-compatible agents.

### Install the skill

```bash
npx skills add ADWilkinson/oneshot-cli
```

Or via [ClawHub](https://clawhub.ai):

```bash
clawhub install oneshot-ship
```

Once installed, your agent can use it automatically when relevant, or you can invoke it directly with `/oneshot-ship`.

## License

MIT
