import type { PipelineContext } from "../config";
import { execOrThrow, OneshotError } from "../exec";
import { getStepTimeout } from "../config";
import { shellEscape } from "../shell";
import { codexEffortConfig, getReviewEffort, getReviewModel, loadPromptTemplate } from "./shared";

export const review = async (ctx: PipelineContext): Promise<void> => {
  const { options, worktreePath } = ctx;
  const baseBranch = options.branch ?? "main";
  const range = `origin/${baseBranch}...HEAD`;
  const branchDiff = await execOrThrow(
    `cd ${shellEscape(worktreePath)} && git diff --stat ${shellEscape(range)}`
  );
  const untracked = await execOrThrow(
    `cd ${shellEscape(worktreePath)} && git ls-files --others --exclude-standard`
  );
  if (!branchDiff.trim() && !untracked.trim()) {
    throw new OneshotError("no changes were made during execution step", "ERR_NO_CHANGES");
  }

  if (options.deepReview || ctx.mode === "deep") {
    await deepReview(ctx);
  } else {
    await standardReview(ctx);
  }
};

const standardReview = async (ctx: PipelineContext): Promise<void> => {
  const { config, worktreePath, options } = ctx;
  const baseBranch = options.branch ?? "main";
  const prompt = loadPromptTemplate("review.txt")
    .replace("{{task}}", options.task)
    .replace(/\{\{baseBranch\}\}/g, baseBranch);
  const timeoutMs = getStepTimeout(config, "reviewMinutes");
  await execOrThrow(
    `cd ${shellEscape(worktreePath)} && codex exec ${shellEscape(prompt)} --dangerously-bypass-approvals-and-sandbox -m ${shellEscape(getReviewModel(ctx))} -c ${shellEscape(codexEffortConfig(getReviewEffort(ctx)))}`,
    { timeoutMs, stream: true }
  );
};

const deepReview = async (ctx: PipelineContext): Promise<void> => {
  const { config, worktreePath, options } = ctx;
  const baseBranch = options.branch ?? "main";
  const timeoutMs = getStepTimeout(config, "deepReviewMinutes");

  const prompt = `You are reviewing code changes for a task.

Task: ${options.task}

Review ALL changes in this branch against origin/${baseBranch} (use git diff origin/${baseBranch}...HEAD, plus any untracked files) in a SINGLE pass:

1. BUGS & LOGIC: off-by-one, null/undefined, race conditions, type mismatches, missing returns
2. SECURITY: injection, secret exposure, auth bypasses, path traversal
3. CODE QUALITY: convention violations, unnecessary complexity, DRY violations, poor naming

Fix any issues directly. Run typecheck and build to verify. Do NOT create commits.`;

  await execOrThrow(
    `cd ${shellEscape(worktreePath)} && codex exec ${shellEscape(prompt)} --dangerously-bypass-approvals-and-sandbox -m ${shellEscape(getReviewModel(ctx))} -c ${shellEscape(codexEffortConfig(getReviewEffort(ctx)))}`,
    { timeoutMs, stream: true }
  );
};
