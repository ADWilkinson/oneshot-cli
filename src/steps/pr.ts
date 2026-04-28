import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { PipelineContext } from "../config";
import { execOrThrow, exec, OneshotError } from "../exec";
import { getStepTimeout } from "../config";
import { shellEscape } from "../shell";
import { PROMPTS_DIR, CLAUDE_PLUGIN_DIR } from "../paths";

const PR_TITLE_FILE = ".oneshot-pr-title.txt";
const PR_BODY_FILE = ".oneshot-pr-body.txt";

const readPrMetadataFile = (worktreePath: string, filename: string): string | null => {
  const path = join(worktreePath, filename);
  if (!existsSync(path)) return null;
  try {
    const content = readFileSync(path, "utf-8").trim();
    return content || null;
  } catch {
    return null;
  }
};

const pluginFlag = CLAUDE_PLUGIN_DIR
  ? `--plugin-dir ${shellEscape(CLAUDE_PLUGIN_DIR)} `
  : "";

const loadPromptTemplate = (): string => {
  return readFileSync(join(PROMPTS_DIR, "pr.txt"), "utf-8");
};

export const getPrModel = (ctx: PipelineContext): string =>
  ctx.options.model ?? ctx.config.claude.model;

const findOrCreateBranch = async (worktreePath: string, slug: string): Promise<string> => {
  const { stdout } = await exec(
    `cd ${shellEscape(worktreePath)} && git ls-remote --heads origin ${shellEscape(`refs/heads/oneshot/${slug}-*`)}`
  );
  const existing = stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.replace(/.*refs\/heads\//, ""))
    .sort()
    .pop();
  if (existing) return existing;
  return `oneshot/${slug}-${Date.now()}`;
};

/**
 * Best-effort snapshot of current worktree commits to origin on a dedicated
 * salvage branch BEFORE we hand off to claude for PR creation. Execute-phase
 * work is therefore durable even if claude, gh, or the PR-extraction regex
 * fails. Idempotent; pushes are force-with-lease to the salvage namespace
 * so we don't race with the prompt's own push of the final branch.
 */
const snapshotWorktreeToOrigin = async (
  worktreePath: string,
  branchSlug: string,
  runId: string
): Promise<void> => {
  const diffCheck = await exec(
    `cd ${shellEscape(worktreePath)} && git diff --stat`
  );
  const untrackedCheck = await exec(
    `cd ${shellEscape(worktreePath)} && git ls-files --others --exclude-standard`
  );
  const hasUncommittedChanges = !!(
    diffCheck.stdout.trim() || untrackedCheck.stdout.trim()
  );

  if (hasUncommittedChanges) {
    try {
      await execOrThrow(`cd ${shellEscape(worktreePath)} && git add -A`);
      await execOrThrow(
        `cd ${shellEscape(worktreePath)} && git -c user.email=oneshot@local -c user.name=oneshot commit -m ${shellEscape("chore: oneshot safety snapshot")}`
      );
    } catch {
      // Commit may fail if nothing staged; non-fatal.
    }
  }

  const aheadCheck = await exec(
    `cd ${shellEscape(worktreePath)} && git rev-list --count origin/main..HEAD`
  );
  if (parseInt(aheadCheck.stdout.trim() || "0", 10) === 0) return;

  const safetyBranch = `oneshot-salvage/${branchSlug}-${runId}`;
  try {
    await execOrThrow(
      `cd ${shellEscape(worktreePath)} && git push origin HEAD:${shellEscape(`refs/heads/${safetyBranch}`)} --force-with-lease`
    );
  } catch {
    // Best effort. Caller continues to PR creation regardless.
  }
};

/**
 * Fallback: if claude's output regex missed but a PR does exist on origin for
 * this branch, recover its URL via the GitHub API. Cheap, idempotent, and
 * narrowly scoped — returns null on any failure so the caller can decide.
 */
const findExistingPrForBranch = async (
  worktreePath: string,
  branchName: string
): Promise<string | null> => {
  try {
    const { stdout } = await exec(
      `cd ${shellEscape(worktreePath)} && gh pr list --head ${shellEscape(branchName)} --state all --json url --jq '.[0].url // empty'`
    );
    const url = stdout.trim();
    return url || null;
  } catch {
    return null;
  }
};

/**
 * Push the branch to origin. Force-with-lease so re-runs on the same branch
 * overwrite cleanly without clobbering unknown upstream work. Retries a
 * couple times on transient git network errors via gitRetry semantics
 * inherited from exec. Throws on persistent failure.
 */
const pushBranchToOrigin = async (
  worktreePath: string,
  branchName: string
): Promise<void> => {
  await execOrThrow(
    `cd ${shellEscape(worktreePath)} && git push -u origin HEAD:${shellEscape(`refs/heads/${branchName}`)} --force-with-lease`
  );
};

/**
 * Use `gh pr edit` (if a PR exists) or `gh pr create --draft` to open a
 * PR with our own title + body, captured directly from `gh` stdout. No
 * regex parsing of claude's conversational output — the URL on the last
 * non-empty stdout line from `gh pr create` is the canonical format
 * (`https://github.com/<org>/<repo>/pull/<n>`).
 */
const openOrUpdateDraftPr = async (
  worktreePath: string,
  branchName: string,
  baseBranch: string,
  title: string,
  body: string
): Promise<string> => {
  const existingUrl = await findExistingPrForBranch(worktreePath, branchName);
  if (existingUrl) {
    await execOrThrow(
      `cd ${shellEscape(worktreePath)} && gh pr edit ${shellEscape(existingUrl)} --title ${shellEscape(title)} --body ${shellEscape(body)}`
    );
    return existingUrl;
  }

  const stdout = await execOrThrow(
    `cd ${shellEscape(worktreePath)} && gh pr create --draft --base ${shellEscape(baseBranch)} --head ${shellEscape(branchName)} --title ${shellEscape(title)} --body ${shellEscape(body)}`
  );
  const urlMatch = stdout.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
  if (!urlMatch) {
    throw new OneshotError(
      `gh pr create succeeded but returned no URL (branch '${branchName}')`,
      "ERR_UNKNOWN",
      stdout.slice(0, 500)
    );
  }
  return urlMatch[0];
};

/**
 * Create a draft PR with all current changes committed and pushed.
 *
 * Control flow — the runtime owns push + PR creation, not claude:
 *
 * 1. Push a salvage snapshot of the execute-phase commits to
 *    `oneshot-salvage/<slug>-<runId>` so the work survives even if anything
 *    below this point explodes.
 * 2. Invoke claude with a prompt that INSTRUCTS IT TO NOT push or open a PR;
 *    it only commits and writes `.oneshot-pr-title.txt` +
 *    `.oneshot-pr-body.txt` at the worktree root.
 * 3. Read those two files (fall back to task text if either is missing).
 * 4. Push the branch ourselves via `git push --force-with-lease`.
 * 5. Open or update the PR ourselves via `gh pr edit` / `gh pr create --draft`,
 *    capturing the URL directly from `gh` stdout — no regex on claude output.
 *
 * This replaces the prior flow where claude did the push + `gh pr create`
 * and we parsed its conversational stdout for a `PR_URL:` line. That flow
 * broke whenever claude decorated the URL differently than the regex
 * expected, and dropped all execute-phase work on the floor.
 */
export const createDraftPr = async (ctx: PipelineContext): Promise<string> => {
  const { config, options, worktreePath, runId } = ctx;

  const branchSlug = options.linearIssueId
    ? options.linearIssueId.toLowerCase()
    : slugify(options.taskSummary ?? options.task) || "task";
  const branchName = await findOrCreateBranch(worktreePath, branchSlug);
  const baseBranch = options.branch ?? "main";
  const taskSummary = options.taskSummary ?? options.task;

  // Belt-and-suspenders: the runtime now owns the push, but keep the salvage
  // branch push too so ANY branching of this flow that fails mid-way (e.g.
  // claude times out before writing the title/body files) still leaves
  // recoverable work on origin.
  await snapshotWorktreeToOrigin(worktreePath, branchSlug, runId);

  const model = getPrModel(ctx);
  const prompt = loadPromptTemplate()
    .replace("{{task}}", taskSummary)
    .replace("{{branchName}}", branchName)
    .replace(/\{\{baseBranch\}\}/g, baseBranch);

  const timeoutMs = getStepTimeout(config, "prMinutes");

  await execOrThrow(
    `cd ${shellEscape(worktreePath)} && claude -p ${shellEscape(prompt)} ${pluginFlag}--dangerously-skip-permissions --model ${shellEscape(model)} --no-session-persistence`,
    { timeoutMs, stream: true }
  );

  const title =
    readPrMetadataFile(worktreePath, PR_TITLE_FILE) ??
    taskSummary.slice(0, 70);
  const body =
    readPrMetadataFile(worktreePath, PR_BODY_FILE) ??
    `## Summary\n\n${taskSummary}\n\n## Test plan\n\nNot run (PR metadata file missing; fallback to task text).\n`;

  await pushBranchToOrigin(worktreePath, branchName);
  return openOrUpdateDraftPr(worktreePath, branchName, baseBranch, title, body);
};

const isAncestor = async (
  worktreePath: string,
  maybeAncestor: string,
  descendant: string
): Promise<boolean> => {
  try {
    await execOrThrow(
      `cd ${shellEscape(worktreePath)} && git merge-base --is-ancestor ${shellEscape(maybeAncestor)} ${shellEscape(descendant)}`
    );
    return true;
  } catch {
    return false;
  }
};

const abortRebaseQuietly = async (worktreePath: string): Promise<void> => {
  try {
    await execOrThrow(`cd ${shellEscape(worktreePath)} && git rebase --abort`);
  } catch {
    // Nothing in progress, or already aborted. Either way we don't want to
    // mask the original rebase error that led us here.
  }
};

const isPushRaceError = (err: unknown): boolean => {
  const msg = err instanceof Error ? err.message : String(err);
  const detail = err instanceof OneshotError ? err.detail ?? "" : "";
  const combined = `${msg} ${detail}`.toLowerCase();
  return (
    combined.includes("non-fast-forward") ||
    combined.includes("fetch first") ||
    combined.includes("updates were rejected") ||
    combined.includes("failed to push some refs") ||
    combined.includes("rejected")
  );
};

/**
 * Fetch → rebase onto remote tip if it moved → push. Retries the full cycle
 * on push-race (non-fast-forward) so we stay resilient when another pusher
 * sneaks a commit in between our fetch and our push. A rebase *conflict*
 * (semantic incompatibility with commits on the remote) is non-retryable and
 * surfaces ERR_REBASE_CONFLICT immediately so the caller can distinguish
 * "lost the race" from "code is fundamentally incompatible".
 */
const syncAndPushWithRetry = async (
  worktreePath: string,
  branchName: string,
  maxAttempts = 3
): Promise<void> => {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await execOrThrow(
      `cd ${shellEscape(worktreePath)} && git fetch origin ${shellEscape(branchName)}`
    );

    const localHead = (
      await execOrThrow(`cd ${shellEscape(worktreePath)} && git rev-parse HEAD`)
    ).trim();
    const remoteTip = (
      await execOrThrow(`cd ${shellEscape(worktreePath)} && git rev-parse FETCH_HEAD`)
    ).trim();

    // If the remote tip is already an ancestor of our local HEAD we're ahead
    // and can push straight. Otherwise the remote has commits we don't have
    // and we need to rebase before pushing.
    if (localHead !== remoteTip && !(await isAncestor(worktreePath, remoteTip, localHead))) {
      try {
        await execOrThrow(
          `cd ${shellEscape(worktreePath)} && git rebase ${shellEscape(remoteTip)}`
        );
      } catch (rebaseErr) {
        await abortRebaseQuietly(worktreePath);
        const detail = rebaseErr instanceof Error ? rebaseErr.message : String(rebaseErr);
        throw new OneshotError(
          `review fix commit could not be rebased onto ${branchName} — conflicting changes on the PR branch. PR left in draft.`,
          "ERR_REBASE_CONFLICT",
          detail
        );
      }
    }

    try {
      await execOrThrow(
        `cd ${shellEscape(worktreePath)} && git push origin HEAD:${shellEscape(`refs/heads/${branchName}`)}`
      );
      return;
    } catch (pushErr) {
      if (!isPushRaceError(pushErr) || attempt === maxAttempts) throw pushErr;
      const delay = 500 * attempt;
      console.warn(
        `[oneshot] push raced on ${branchName}, retrying in ${delay}ms (${attempt}/${maxAttempts})`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw new OneshotError(
    `syncAndPushWithRetry exhausted ${maxAttempts} attempts on ${branchName}`,
    "ERR_UNKNOWN"
  );
};

/**
 * After review, commit any fixes and push. Then mark the PR as ready.
 * If review made no changes, just marks the PR as ready.
 *
 * Handles concurrent pushers on the same PR branch (another oneshot run
 * sharing the branch, oneshot-bot's auto-fixer, a human pushing manually)
 * via syncAndPushWithRetry: fetch → rebase → push with retry on push-race.
 * A semantic rebase conflict still surfaces ERR_REBASE_CONFLICT so the
 * draft PR is preserved and a human can take over.
 */
export const finalizeAfterReview = async (
  ctx: PipelineContext,
  opts: { markReady?: boolean; commitMessage?: string } = {}
): Promise<void> => {
  const { markReady = true, commitMessage = "fix: address review findings" } = opts;
  const { worktreePath, prUrl } = ctx;

  const diffCheck = await exec(`cd ${shellEscape(worktreePath)} && git diff --stat`);
  const untracked = await exec(
    `cd ${shellEscape(worktreePath)} && git ls-files --others --exclude-standard`
  );
  const hasChanges = !!(diffCheck.stdout.trim() || untracked.stdout.trim());

  if (hasChanges) {
    await execOrThrow(`cd ${shellEscape(worktreePath)} && git add -A`);
    await execOrThrow(`cd ${shellEscape(worktreePath)} && git commit -m ${shellEscape(commitMessage)}`);

    const branchResult = await execOrThrow(
      `cd ${shellEscape(worktreePath)} && git rev-parse --abbrev-ref HEAD`
    );
    const branchName = branchResult.trim();
    if (!branchName || branchName === "HEAD") {
      throw new OneshotError(
        `cannot finalize: worktree is in detached-HEAD state, expected to be on a branch`,
        "ERR_UNKNOWN"
      );
    }

    await syncAndPushWithRetry(worktreePath, branchName);
  }

  if (!markReady) return;
  const prNumber = prUrl.match(/\/pull\/(\d+)/)?.[1];
  if (!prNumber) throw new Error(`could not extract PR number from URL: ${prUrl}`);
  await execOrThrow(`cd ${shellEscape(worktreePath)} && gh pr ready ${shellEscape(prNumber)}`);
};

export const getFilesChanged = async (ctx: PipelineContext): Promise<number> => {
  const baseBranch = ctx.options.branch ?? "main";
  const result = await execOrThrow(
    `cd ${shellEscape(ctx.worktreePath)} && git diff --stat ${shellEscape(`origin/${baseBranch}...HEAD`)} | tail -1`
  );
  const match = result.match(/(\d+) files? changed/);
  return match ? parseInt(match[1], 10) : 0;
};

export const getDiffStats = async (ctx: PipelineContext): Promise<Array<{ file: string; additions: number; deletions: number }>> => {
  try {
    const baseBranch = ctx.options.branch ?? "main";
    const result = await execOrThrow(
      `cd ${shellEscape(ctx.worktreePath)} && git diff --numstat ${shellEscape(`origin/${baseBranch}...HEAD`)}`
    );
    return result.trim().split('\n').filter(Boolean).map(line => {
      const [add, del, file] = line.split('\t');
      return { file, additions: parseInt(add, 10) || 0, deletions: parseInt(del, 10) || 0 };
    });
  } catch {
    return [];
  }
};

const slugify = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
