import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { PipelineContext } from "../config";
import { execOrThrow, OneshotError } from "../exec";
import { getStepTimeout } from "../config";

const __dirname = dirname(fileURLToPath(import.meta.url));

const loadPromptTemplate = (): string => {
  return readFileSync(join(__dirname, "..", "..", "prompts", "review.txt"), "utf-8");
};

const getReviewModel = (ctx: PipelineContext): string =>
  ctx.config.codex.reviewModel ?? "gpt-5.4-mini";

const getReviewEffort = (ctx: PipelineContext): string =>
  ctx.config.codex.reviewReasoningEffort ?? "xhigh";

export const review = async (ctx: PipelineContext): Promise<void> => {
  const { options, worktreePath } = ctx;

  const diff = await execOrThrow(`cd "${worktreePath}" && git diff --stat`);
  const untracked = await execOrThrow(`cd "${worktreePath}" && git ls-files --others --exclude-standard`);
  if (!diff.trim() && !untracked.trim()) throw new OneshotError("no changes were made during execution step", "ERR_NO_CHANGES");

  if (options.deepReview || ctx.mode === "deep") {
    await deepReview(ctx);
  } else {
    await standardReview(ctx);
  }
};

const standardReview = async (ctx: PipelineContext): Promise<void> => {
  const { config, worktreePath, options } = ctx;
  const prompt = loadPromptTemplate().replace("{{task}}", options.task);
  const escapedPrompt = prompt.replace(/'/g, "'\\''");
  const timeoutMs = getStepTimeout(config, "reviewMinutes");
  const model = getReviewModel(ctx);
  const effort = getReviewEffort(ctx);
  await execOrThrow(
    `cd "${worktreePath}" && codex exec '${escapedPrompt}' --dangerously-bypass-approvals-and-sandbox -m ${model} -c 'model_reasoning_effort="${effort}"'`,
    { timeoutMs, stream: true }
  );
};

const deepReview = async (ctx: PipelineContext): Promise<void> => {
  const { config, worktreePath, options } = ctx;
  const timeoutMs = getStepTimeout(config, "deepReviewMinutes");
  const model = getReviewModel(ctx);
  const effort = getReviewEffort(ctx);

  const prompt = `You are reviewing code changes for a task.

Task: ${options.task}

Review ALL changes (git diff + any new files) in a SINGLE pass:

1. BUGS & LOGIC: off-by-one, null/undefined, race conditions, type mismatches, missing returns
2. SECURITY: injection, secret exposure, auth bypasses, path traversal
3. CODE QUALITY: convention violations, unnecessary complexity, DRY violations, poor naming

Fix any issues directly. Run typecheck and build to verify. Do NOT create commits.`;

  const escapedPrompt = prompt.replace(/'/g, "'\\''");
  await execOrThrow(
    `cd "${worktreePath}" && codex exec '${escapedPrompt}' --dangerously-bypass-approvals-and-sandbox -m ${model} -c 'model_reasoning_effort="${effort}"'`,
    { timeoutMs, stream: true }
  );
};
