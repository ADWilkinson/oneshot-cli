import { readFileSync } from "fs";
import { join } from "path";
import type { PipelineContext } from "../config";
import { execOrThrow, OneshotError } from "../exec";
import { getStepTimeout } from "../config";
import { shellEscape } from "../shell";
import { PROMPTS_DIR } from "../paths";
import type { EventWriter } from "../events";
import { runCodexJson } from "../codex-runner";

const loadPromptTemplate = (): string => {
  return readFileSync(join(PROMPTS_DIR, "review.txt"), "utf-8");
};

const getReviewModel = (ctx: PipelineContext): string =>
  ctx.config.codex.reviewModel ?? "gpt-5.5";

const getReviewEffort = (ctx: PipelineContext): string =>
  ctx.config.codex.reviewReasoningEffort ?? "xhigh";

export const review = async (ctx: PipelineContext, events: EventWriter): Promise<void> => {
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
    await deepReview(ctx, events);
  } else {
    await standardReview(ctx, events);
  }
};

const standardReview = async (ctx: PipelineContext, events: EventWriter): Promise<void> => {
  const { config, worktreePath, options } = ctx;
  const baseBranch = options.branch ?? "main";
  const prompt = loadPromptTemplate()
    .replace("{{task}}", options.task)
    .replace(/\{\{baseBranch\}\}/g, baseBranch);
  const timeoutMs = getStepTimeout(config, "reviewMinutes");
  const model = getReviewModel(ctx);
  const effort = getReviewEffort(ctx);
  await runCodexJson({
    worktreePath,
    prompt,
    model,
    reasoningEffort: effort,
    timeoutMs,
    step: 7,
    events,
  });
};

const deepReview = async (ctx: PipelineContext, events: EventWriter): Promise<void> => {
  const { config, worktreePath, options } = ctx;
  const baseBranch = options.branch ?? "main";
  const timeoutMs = getStepTimeout(config, "deepReviewMinutes");
  const model = getReviewModel(ctx);
  const effort = getReviewEffort(ctx);

  const prompt = `You are reviewing code changes for a task.

Task: ${options.task}

Review ALL changes in this branch against origin/${baseBranch} (use git diff origin/${baseBranch}...HEAD, plus any untracked files) in a SINGLE pass:

1. BUGS & LOGIC: off-by-one, null/undefined, race conditions, type mismatches, missing returns
2. SECURITY: injection, secret exposure, auth bypasses, path traversal
3. CODE QUALITY: convention violations, unnecessary complexity, DRY violations, poor naming

Fix any issues directly. Run typecheck and build to verify. Do NOT create commits.`;

  await runCodexJson({
    worktreePath,
    prompt,
    model,
    reasoningEffort: effort,
    timeoutMs,
    step: 7,
    events,
  });
};
