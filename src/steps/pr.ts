import { readFileSync } from "fs";
import { join } from "path";
import type { PipelineContext } from "../config";
import { execOrThrow, exec, OneshotError } from "../exec";
import { getStepTimeout } from "../config";
import { shellEscape } from "../shell";
import { PROMPTS_DIR, CLAUDE_PLUGIN_DIR } from "../paths";

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
    `cd ${shellEscape(worktreePath)} && git ls-remote --heads origin 'refs/heads/oneshot/${shellEscape(slug)}-*'`
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
 * Create a draft PR with all current changes committed and pushed.
 * Returns the PR URL. The PR is created as draft so review can push fixes on top.
 */
export const createDraftPr = async (ctx: PipelineContext): Promise<string> => {
  const { config, options, worktreePath } = ctx;

  const branchSlug = options.linearIssueId
    ? options.linearIssueId.toLowerCase()
    : slugify(options.taskSummary ?? options.task) || "task";
  const branchName = await findOrCreateBranch(worktreePath, branchSlug);
  const baseBranch = options.branch ?? "main";
  const taskSummary = options.taskSummary ?? options.task;

  const model = getPrModel(ctx);
  const prompt = loadPromptTemplate()
    .replace("{{task}}", taskSummary)
    .replace("{{branchName}}", branchName)
    .replace(/\{\{baseBranch\}\}/g, baseBranch);

  const timeoutMs = getStepTimeout(config, "prMinutes");

  const result = await execOrThrow(
    `cd ${shellEscape(worktreePath)} && claude -p ${shellEscape(prompt)} ${pluginFlag}--dangerously-skip-permissions --model ${shellEscape(model)} --no-session-persistence`,
    { timeoutMs, stream: true }
  );

  const prUrlMatch = result.match(/PR_URL:\s*(https:\/\/github\.com\/\S+)/);
  if (prUrlMatch) return prUrlMatch[1];

  const urlMatch = result.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
  if (urlMatch) return urlMatch[0];

  throw new Error("could not extract PR URL from claude output");
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
