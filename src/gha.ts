import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";

/**
 * GitHub Actions backend: the durable, zero-infra executor everyone already has.
 *
 * A detached run needs to survive your laptop closing. Not everyone has a 24/7
 * dev box, but every repo has Actions: it survives anything, has a secrets
 * vault, and can open PRs natively. `oneshot gha init` scaffolds a workflow that
 * runs the same contract in CI and uploads the receipt as an artifact.
 *
 * This module only scaffolds the workflow file. The live run additionally needs
 * an agent API key in the repo's Actions secrets -- an inherent requirement we
 * surface to the user, not something oneshot can or should provide.
 */

export const GHA_WORKFLOW_PATH = ".github/workflows/oneshot.yml";

export interface GhaScaffoldOptions {
  /** "codex" or "claude" -- selects which CLI + secret the workflow wires up. */
  provider?: "codex" | "claude";
}

export const renderWorkflow = (options: GhaScaffoldOptions = {}): string => {
  const provider = options.provider ?? "codex";
  const isClaude = provider === "claude";
  const secretName = isClaude ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
  const installAgent = isClaude
    ? "          bun install -g @anthropic-ai/claude-code"
    : "          bun install -g @openai/codex";

  return `# Managed by oneshot (oneshot gha init). Safe to edit.
#
# Durable, detached oneshot runs in CI. Trigger from the Actions tab or with:
#   gh workflow run oneshot.yml -f task="fix the login timeout"
#
# Required once, in repo Settings -> Secrets and variables -> Actions:
#   ${secretName}   (the agent provider key the contract runs under)
# GITHUB_TOKEN is provided automatically and is used to open the PR.
name: oneshot

on:
  workflow_dispatch:
    inputs:
      task:
        description: Task or Linear URL for oneshot to ship
        required: true
        type: string
      branch:
        description: Base branch to work from and PR into
        required: false
        default: main
        type: string
      mode:
        description: Review depth
        required: false
        default: deep
        type: choice
        options: [deep, fast]

permissions:
  contents: write
  pull-requests: write

jobs:
  oneshot:
    runs-on: ubuntu-latest
    timeout-minutes: 120
    steps:
      - name: Checkout into owner/repo layout
        uses: actions/checkout@v4
        with:
          path: workspace/\${{ github.repository }}
          fetch-depth: 0

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install oneshot and agent CLI
        run: |
          bun install -g oneshot-ship
${installAgent}

      - name: Run oneshot contract
        env:
          ${secretName}: \${{ secrets.${secretName} }}
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: |
          git config --global user.name "oneshot[bot]"
          git config --global user.email "oneshot@users.noreply.github.com"
          oneshot "\${{ github.repository }}" "\${{ inputs.task }}" \\
            --local \\
            --base-path "\$GITHUB_WORKSPACE/workspace" \\
            --branch "\${{ inputs.branch }}" \\
            --mode "\${{ inputs.mode }}" \\
            --events-file "\$GITHUB_WORKSPACE/oneshot-run.events.jsonl"

      - name: Build receipt artifact
        if: always()
        run: |
          run_id="\$(ls -1 "\$HOME/.oneshot/runs"/*.receipt.json 2>/dev/null | head -1 | xargs -r basename | sed 's/\\.receipt\\.json\$//')"
          if [ -n "\$run_id" ]; then
            oneshot receipt "\$run_id" --local --html > "\$GITHUB_WORKSPACE/oneshot-receipt.html" || true
            oneshot receipt "\$run_id" --local --json > "\$GITHUB_WORKSPACE/oneshot-receipt.json" || true
          fi

      - name: Upload receipt
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: oneshot-receipt
          path: |
            oneshot-receipt.html
            oneshot-receipt.json
            oneshot-run.events.jsonl
          if-no-files-found: ignore
`;
};

export interface GhaInitResult {
  path: string;
  created: boolean;
  secretName: string;
}

export const initGhaWorkflow = (
  targetDir = process.cwd(),
  options: GhaScaffoldOptions = {},
): GhaInitResult => {
  const provider = options.provider ?? "codex";
  const secretName = provider === "claude" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
  const path = join(targetDir, GHA_WORKFLOW_PATH);
  if (existsSync(path)) return { path, created: false, secretName };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderWorkflow(options));
  return { path, created: true, secretName };
};
