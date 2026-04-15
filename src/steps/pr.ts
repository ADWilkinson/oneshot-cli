import type { PipelineContext } from "../config";
import { execOrThrow, exec, OneshotError } from "../exec";
import { getStepTimeout } from "../config";
import { shellEscape } from "../shell";
import { getPluginFlag, loadPromptTemplate } from "./shared";

export const getPrModel = (ctx: PipelineContext): string =>
  ctx.options.model ?? ctx.config.claude.model;

/**
 * Create a draft PR with all current changes committed and pushed.
 * Returns the PR URL. The PR is created as draft so review can push fixes on top.
 */
export const createDraftPr = async (ctx: PipelineContext): Promise<string> => {
  const { config, options, worktreePath } = ctx;

  const branchSlug = options.linearIssueId
    ? options.linearIssueId.toLowerCase()
    : slugify(options.taskSummary ?? options.task) || "task";
  const branchName = `oneshot/${branchSlug}-${Date.now()}`;
  const baseBranch = options.branch ?? "main";
  const taskSummary = options.taskSummary ?? options.task;

  const model = getPrModel(ctx);
  const prompt = loadPromptTemplate("pr.txt")
    .replace("{{task}}", taskSummary)
    .replace("{{branchName}}", branchName)
    .replace(/\{\{baseBranch\}\}/g, baseBranch);

  const timeoutMs = getStepTimeout(config, "prMinutes");

  const result = await execOrThrow(
    `cd ${shellEscape(worktreePath)} && claude -p ${shellEscape(prompt)} ${getPluginFlag()}--dangerously-skip-permissions --model ${shellEscape(model)} --no-session-persistence`,
    { timeoutMs, stream: true }
  );

  const prUrlMatch = result.match(/PR_URL:\s*(https:\/\/github\.com\/\S+)/);
  if (prUrlMatch) return prUrlMatch[1];

  const urlMatch = result.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
  if (urlMatch) return urlMatch[0];

  throw new Error("could not extract PR URL from claude output");
};

/**
 * After review, commit any fixes and push. Then mark the PR as ready.
 * If review made no changes, just marks the PR as ready.
 *
 * Handles the case where something else (e.g. oneshot-bot's auto-fixer) has
 * raced us and pushed to the PR branch while the review step was running:
 * fetch the remote, rebase our review commit onto the new tip, and push.
 * If the rebase conflicts we abort cleanly and throw ERR_REBASE_CONFLICT so
 * the caller can distinguish "our review lost the race" from a real failure.
 */
export const finalizeAfterReview = async (ctx: PipelineContext): Promise<void> => {
  const { worktreePath, prUrl } = ctx;

  const diffCheck = await exec(`cd ${shellEscape(worktreePath)} && git diff --stat`);
  const untracked = await exec(
    `cd ${shellEscape(worktreePath)} && git ls-files --others --exclude-standard`
  );
  const hasChanges = !!(diffCheck.stdout.trim() || untracked.stdout.trim());

  if (hasChanges) {
    await execOrThrow(`cd ${shellEscape(worktreePath)} && git add -A`);
    await execOrThrow(`cd ${shellEscape(worktreePath)} && git commit -m "fix: address review findings"`);

    // Figure out which branch we're on (claude -p in createDraftPr should
    // have checked out an oneshot/... branch before committing the PR commit).
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

    // Fetch the remote branch to see whether anything raced us while review ran.
    await execOrThrow(
      `cd ${shellEscape(worktreePath)} && git fetch origin ${shellEscape(branchName)}`
    );

    // HEAD^ is the commit the review commit was built on (the PR's feat commit).
    // If FETCH_HEAD points at the same SHA, nothing raced us and we can push
    // straight. Otherwise the remote has moved and we need to rebase our review
    // commit onto the new tip before pushing.
    const localBase = (
      await execOrThrow(`cd ${shellEscape(worktreePath)} && git rev-parse HEAD^`)
    ).trim();
    const remoteTip = (
      await execOrThrow(`cd ${shellEscape(worktreePath)} && git rev-parse FETCH_HEAD`)
    ).trim();

    if (localBase !== remoteTip) {
      try {
        await execOrThrow(
          `cd ${shellEscape(worktreePath)} && git rebase FETCH_HEAD`
        );
      } catch (rebaseErr) {
        // Abort so the worktree is clean for teardown. Swallow any failure
        // from the abort itself — if there's nothing to abort git will just
        // complain and we don't want to mask the original rebase error.
        await exec(`cd ${shellEscape(worktreePath)} && git rebase --abort`);
        const detail = rebaseErr instanceof Error ? rebaseErr.message : String(rebaseErr);
        throw new OneshotError(
          `review fix commit could not be rebased onto ${branchName} — another process pushed conflicting changes while the review was running. PR left in draft.`,
          "ERR_REBASE_CONFLICT",
          detail
        );
      }
    }

    // Use an explicit refspec so push works even if the local branch doesn't
    // have an upstream configured (claude -p may push without --set-upstream).
    await execOrThrow(
      `cd ${shellEscape(worktreePath)} && git push origin HEAD:${shellEscape(`refs/heads/${branchName}`)}`
    );
  }

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
