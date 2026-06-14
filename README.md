# oneshot

[![npm](https://img.shields.io/npm/v/oneshot-ship?color=black&label=npm)](https://www.npmjs.com/package/oneshot-ship)
[![license](https://img.shields.io/github/license/ADWilkinson/oneshot-cli?color=black)](LICENSE)
[![docs](https://img.shields.io/badge/docs-adwilkinson.github.io-black)](https://adwilkinson.github.io/oneshot-cli)

Fire-and-forget agentic software work. Repo + task in, detached agent run out, reviewed PR plus a proof-of-work receipt ready.

```
laptop -> server, local worktree, or GitHub Actions -> Codex/Claude -> reviewed PR + receipt
```

`oneshot` is a tiny public workflow runtime for agentic software work. It gives coding agents the boring-but-crucial rails they need in the real world: clean worktrees, provider routing, durable logs, policy gates, review loops, PR creation, and a receipt that proves the whole contract actually ran.

It runs over SSH to a dev box, entirely locally with `--local`, or detached in CI with `oneshot gha init`.

## Why try it

- **Fire and forget**: detach a task with `--bg` (or in CI), close your laptop, get pinged when the receipt is ready.
- **Proof of work**: every run writes a receipt (plan, contract steps, review outcome, policy verdict, assumptions, confidence) so you can trust a detached result without re-reading the whole diff. `oneshot receipt <run-id> --html`.
- **No dirty main branch**: every run gets an isolated git worktree, so parallel work is safe.
- **Bring your agent**: Codex-first by default, Claude-compatible, with adaptive routing when enabled.
- **Durable anywhere**: SSH to your own box, a local detached process, or GitHub Actions for zero-infra runs that survive your machine.
- **Observable by design**: every run writes JSONL events plus a durable ledger you can inspect later.
- **Workflow-shaped**: use presets like `ship`, `review`, `fix-ci`, `research`, `docs`, and `swarm-review`.
- **Policy-aware**: add `.oneshot/policy.json` for protected paths, secret checks, and required repo gates.
- **Toolable**: `oneshot mcp serve` exposes the same engine to MCP-capable agent clients.

## Install

Requires [Bun](https://bun.sh). macOS and Linux.

```bash
bun install -g oneshot-ship
```

## Quick start

```bash
oneshot init                                    # configure
oneshot doctor                                  # check local + remote setup
oneshot doctor --repo my-org/my-app             # verify a checkout target
oneshot my-org/my-app "fix the login timeout"   # ship
```

Try the runtime surface:

```bash
oneshot workflow list
oneshot my-org/my-app "fix failing CI" --workflow fix-ci
oneshot runs
oneshot status <run-id|events-file> --json
oneshot eval --json
oneshot mcp serve
```

## How it works

oneshot runs an 8-step pipeline. Each run gets its own git worktree in `/tmp`, so your main branch is never touched. Parallel runs on the same repo are safe.

| Step | Engine | What it does |
|------|--------|-------------|
| 1. Validate | git | Checks the repo exists, fetches latest |
| 2. Worktree | git | Creates an isolated `/tmp` worktree from `origin/main` |
| 3. Route | Adaptive router | Picks provider, reasoning, context shape, execution style, and fast/deep mode |
| 4. Plan | Routed | Reads the codebase + repo instructions, outputs an implementation plan |
| 5. Execute | Routed | Implements the plan |
| 6. Draft PR | Configurable | Creates branch, commits, and writes PR metadata; runtime pushes and opens or updates the draft PR |
| 7. Review | Configurable | Reviews the diff across correctness, compatibility, policy, security, and docs. Fixes issues directly |
| 8. Finalize | git/gh | Pushes review fixes and marks PR ready, or preserves the draft if review fails |

If execute times out with partial changes, the draft PR is still created so nothing is lost.

## Usage

```bash
oneshot <repo> "<task>"                 # ship a task
oneshot <repo> <linear-url>            # ship from a Linear ticket
oneshot <repo> "<task>" --bg           # fire and forget
oneshot <repo> "<task>" --local        # run locally, no SSH
oneshot <repo> "<task>" --mode deep    # skip classification and force deep mode
oneshot <repo> "<task>" --workflow ship # apply a workflow preset
oneshot <repo> "<task>" --deep-review  # force exhaustive review
oneshot <repo> "<task>" --model gpt-5.5 # override configured plan/PR model
oneshot <repo> "<task>" --branch dev   # target a different branch
oneshot <repo> "<task>" --base-path /srv/workspaces  # override repo root for this run
oneshot <repo> "<task>" --worktree-root /tmp/agents   # override temp worktree root
oneshot <repo> --dry-run               # validate only
oneshot init                           # configure
oneshot stats                          # recent runs + timing
oneshot runs                           # durable run ledger
oneshot runs --json --limit 10         # list runs for automation
oneshot status <run-id|events-file> --json  # inspect one run
oneshot receipt <run-id>               # proof-of-work receipt (text)
oneshot receipt <run-id> --html        # receipt as a self-contained HTML artifact
oneshot eval --json                    # summarize run outcomes
oneshot doctor                         # setup and remote health checks
oneshot doctor --repo my-org/my-app    # setup + checkout health
oneshot route "fix failing CI and publish" --json  # inspect the hidden route
oneshot workflow list                  # inspect workflow presets
oneshot workflow show fix-ci --json    # inspect one workflow preset
oneshot policy init                    # create .oneshot/policy.json
oneshot policy init --path ./repo      # write policy in another directory
oneshot gha init                       # scaffold a GitHub Actions workflow for detached runs
oneshot mcp serve                      # expose oneshot as MCP tools
```

### Flags

| Flag | Short | Description |
|------|-------|-------------|
| `--model` | `-m` | Override configured plan/PR model |
| `--branch` | `-b` | Base branch (default: main) |
| `--base-path` | | Override the workspace path used to locate the repo |
| `--worktree-root` | | Override where temporary git worktrees are created |
| `--mode` | | Skip classification and force `fast` or `deep` mode |
| `--workflow` | | Apply a workflow preset: `ship`, `review`, `fix-ci`, `research`, `docs`, or `swarm-review` |
| `--deep-review` | | Force exhaustive review mode |
| `--local` | | Run locally instead of over SSH |
| `--bg` | | Run detached in background (returns PID + log path) |
| `--dry-run` | `-d` | Validate only |
| `--events-file` | | Mirror JSONL events to an additional file |
| `--repo` | | With `doctor`, verify a specific `owner/repo` checkout exists |
| `--provider` | | With `route`, choose the fallback provider (`codex` or `claude`) |

## Prerequisites

**On your laptop:** [Bun](https://bun.sh), SSH access to your server

**On your server (or local machine with `--local`):**
- [Bun](https://bun.sh)
- Either [Codex CLI](https://github.com/openai/codex) or [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)
- [GitHub CLI](https://cli.github.com) (authenticated)
- `OPENAI_API_KEY` for Codex mode, or `ANTHROPIC_API_KEY` for Claude mode

## Configuration

`~/.oneshot/config.json`, created by `oneshot init`:

```json
{
  "host": "user@100.x.x.x",
  "basePath": "~/projects",
  "provider": "codex",
  "routing": { "enabled": true },
  "linearApiKey": "lin_api_...",
  "claude": {
    "model": "opus",
    "timeoutMinutes": 180
  },
  "codex": {
    "model": "gpt-5.5",
    "reasoningEffort": "xhigh",
    "reviewModel": "gpt-5.5",
    "reviewReasoningEffort": "xhigh",
    "timeoutMinutes": 180
  },
  "phases": {
    "classify": { "model": "gpt-5.5", "reasoningEffort": "medium" },
    "plan": { "model": "gpt-5.5", "reasoningEffort": "xhigh" },
    "execute": {
      "model": "gpt-5.5",
      "reasoningEffort": "xhigh"
    },
    "review": {
      "model": "gpt-5.5",
      "reasoningEffort": "xhigh"
    },
    "deepReview": {
      "model": "gpt-5.5",
      "reasoningEffort": "xhigh"
    },
    "pr": { "model": "gpt-5.5", "reasoningEffort": "high" }
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
Remote SSH runs stream the active oneshot config to the server for that run, so `basePath`, provider defaults, timeout settings, and configured Linear credentials stay aligned without requiring a duplicate `~/.oneshot/config.json` on the server.

| Key | Required | Description |
|-----|----------|-------------|
| `host` | SSH only | SSH target, e.g. `user@192.168.1.10` |
| `basePath` | No | Where repos live. Default: `~/projects` |
| `worktreeRoot` | No | Scratch directory for temporary git worktrees. Default: `/tmp` |
| `provider` | No | Fallback agent provider when adaptive routing is off or no route rule wins. Default: `codex` |
| `routing.enabled` | No | Enables invisible provider/reasoning routing. Codex and Claude still use their configured frontier model; the router varies provider and effort, not model class |
| `anthropicApiKey` | Claude only | Falls back to `ANTHROPIC_API_KEY` env var |
| `linearApiKey` | No | Enables Linear ticket integration |
| `claude.model` | Claude only | Default Claude model. Default: `opus` |
| `codex.model` | Codex only | Default Codex model. Default: `gpt-5.5` |
| `codex.reasoningEffort` | Codex only | Default Codex reasoning effort. Default: `xhigh` |
| `codex.reviewModel` | Codex only | Default for review phases. Default: same as `codex.model` |
| `codex.reviewReasoningEffort` | Codex only | Default review reasoning effort. Default: same as `codex.reasoningEffort` |
| `phases.<phase>.model` | No | Exact model for that phase under the selected provider |
| `phases.<phase>.reasoningEffort` | No | Reasoning effort for that phase, e.g. `medium`, `high`, `xhigh`. Passed to Codex and to Claude via `--effort` |
| `stepTimeouts` | No | Per-step timeout overrides in minutes |

`phases` is optional. If it is omitted, every agent phase uses the selected provider and its default model settings. Any stale `phases.<phase>.provider` values from older configs are ignored when adaptive routing is off. With `routing.enabled: true`, oneshot's adaptive router can silently choose Codex or Claude per task while preserving each provider's configured frontier model.

Adaptive routing is intentionally invisible during normal use. Code edits, tests, refactors, PR work, and ship requests route to Codex by default. Tool-heavy operations, browser/admin/log/service work, and external workflow orchestration can route to Claude. If code will be edited, Codex wins the tie. Use `oneshot route "<task>" --json` only when you want to inspect the decision.

Repos on the server should live as `<org>/<repo>` under the base path. Repo slugs are intentionally strict: exactly `owner/repo`, using only letters, numbers, dot, underscore, and hyphen. Nested paths and `..` are rejected before any filesystem access.

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

**CLAUDE.md**: put one in any repo root. oneshot passes it to the configured agents for planning and execution. Use it for coding standards, architecture decisions, test requirements.

**Prompt templates**: edit these to change pipeline behavior:

| File | Controls |
|------|----------|
| `prompts/plan.txt` | How the plan agent explores and plans |
| `prompts/execute.txt` | How the execute agent implements changes |
| `prompts/review.txt` | How the review agent reviews the diff |
| `prompts/pr.txt` | How the PR agent writes branch/commit/PR metadata |

Templates use `{{variable}}` placeholders replaced at runtime.

The repo's `CLAUDE.md` is also supplied to the planning and execution steps, so the task string is the primary operator input, not the only context the agents receive.

For dense specs, explainers, review maps, incident reports, design sheets, or one-off editors, the templates allow a self-contained HTML artifact instead of a long markdown document. Durable artifacts should live under `docs/artifacts/`; throwaway local artifacts should stay under `/tmp/oneshot-html-artifacts/`.

## Events

Every run writes JSONL events to `/tmp/oneshot-<runId>.events.jsonl` and the durable local ledger at `~/.oneshot/runs/<runId>.events.jsonl`. Use `--events-file <path>` to mirror to another file:

```bash
oneshot acme/api "fix bug" --local --events-file /tmp/run.events.jsonl
```

Events:

- `started` (includes runtime metadata such as CLI version, host, pid, cwd, platform, and worktree root), `classified`, `step` (running/done/failed), `completed` (success/failed/dry-run)
- `agent` for live agent activity: commands, tools, file changes, todos, web searches, warnings, draft PR creation, and turn/session markers

## Workflows, policy, and MCP

Workflow presets wrap a task with a stronger operating mode while keeping the CLI portable:

```bash
oneshot workflow list
oneshot acme/api "fix the failing payment test" --workflow fix-ci
oneshot acme/web "review PR feedback and make it shippable" --workflow review
```

Policy packs live at `.oneshot/policy.json`. The default pack protects secret-like files and can require repo-specific checks before a draft PR is created:

```bash
oneshot policy init
```

`oneshot mcp serve` exposes the public engine as MCP tools for agent clients. The server supports running a task, listing runs, reading run status, reading a run receipt, initializing policy, listing workflows, and summarizing eval outcomes.

## Receipts

Every run writes a proof-of-work receipt to `~/.oneshot/runs/<runId>.receipt.json`. The receipt is the thing that makes fire-and-forget trustworthy: it records what was planned, which contract steps ran and how long they took, the review outcome (passed / timed-out / failed), the policy verdict, the defaults the run had to assume because a detached run cannot ask you, and a derived confidence rating (`high` only when the run shipped with a clean review and a clean policy gate).

```bash
oneshot receipt <run-id>            # human-readable sitrep
oneshot receipt <run-id> --json     # machine-readable
oneshot receipt <run-id> --html > receipt.html   # self-contained artifact
```

Runs without a receipt file (older or remote-only runs) reconstruct a thinner receipt from the event stream; reconstructed successes are capped at `medium` confidence since the contract verdict cannot be re-derived.

## Notifications

So a detached run can ping you when its receipt is ready, add a `notify` block to `~/.oneshot/config.json`. It is backend-agnostic on purpose: wire Slack, Discord, a desktop toast, or anything else yourself. Notification is best effort and never fails a run.

```json
{
  "notify": {
    "webhook": "https://hooks.example.com/oneshot",
    "command": "my-notify-script.sh",
    "onSuccess": true,
    "onFailure": true
  }
}
```

The webhook receives the receipt summary as a JSON POST. The command runs with the same payload on stdin and in `ONESHOT_NOTIFY_STATUS`, `ONESHOT_NOTIFY_REPO`, `ONESHOT_NOTIFY_HEADLINE`, `ONESHOT_NOTIFY_PR_URL`, `ONESHOT_NOTIFY_RECEIPT`, and `ONESHOT_NOTIFY_JSON`.

## GitHub Actions backend

Not everyone has a 24/7 dev box, but every repo has Actions: a durable executor that survives your laptop closing, with a secrets vault, that can open PRs natively. `oneshot gha init` scaffolds a `workflow_dispatch` workflow that runs the same contract in CI and uploads the receipt as an artifact.

```bash
oneshot gha init                       # writes .github/workflows/oneshot.yml
oneshot gha init --provider claude     # wire the Anthropic key instead of OpenAI
gh workflow run oneshot.yml -f task="fix the login timeout"
```

It requires one provider API key in the repo's Actions secrets (`OPENAI_API_KEY` for Codex, `ANTHROPIC_API_KEY` for Claude); `GITHUB_TOKEN` is provided automatically and opens the PR. The command prints exactly which secret to add.

## Doctor and recovery

`oneshot doctor` checks the installed package freshness against npm, local prerequisites, config file, recent event stream, SSH reachability, and remote binaries when a remote host is configured. Use `oneshot doctor --local --json` for machine-readable local checks.

Add `--repo <owner/repo>` to verify the configured local or remote base path actually contains the checkout before dispatch:

```bash
oneshot doctor --repo zkp2p/pay
oneshot doctor --local --repo zkp2p/pay --json
```

Failed runs preserve the worktree under the configured `worktreeRoot` and write a failed `completed` event with the error code and completed step timings. Start with `oneshot runs`, `oneshot status <run-id>`, and `oneshot eval`, then inspect the event file or preserved worktree path printed in the logs.

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
