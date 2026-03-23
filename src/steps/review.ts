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

export const review = async (ctx: PipelineContext): Promise<void> => {
  const { options, worktreePath } = ctx;

  // Quick check that there are changes to review (tracked modifications + new untracked files)
  const diff = await execOrThrow(`cd "${worktreePath}" && git diff --stat`);
  const untracked = await execOrThrow(`cd "${worktreePath}" && git ls-files --others --exclude-standard`);
  if (!diff.trim() && !untracked.trim()) throw new OneshotError("no changes were made during execution step", 'ERR_NO_CHANGES');

  if (options.deepReview || ctx.mode === 'deep') {
    await deepReview(ctx);
  } else {
    await standardReview(ctx);
  }
};

const standardReview = async (ctx: PipelineContext): Promise<void> => {
  const { config, worktreePath, options } = ctx;
  const prompt = loadPromptTemplate()
    .replace("{{task}}", options.task);
  const escapedPrompt = prompt.replace(/'/g, "'\\''");
  const timeoutMs = getStepTimeout(config, "reviewMinutes");
  await execOrThrow(
    `cd "${worktreePath}" && codex exec '${escapedPrompt}' --dangerously-bypass-approvals-and-sandbox -m ${config.codex.model} -c 'model_reasoning_effort="${config.codex.reasoningEffort}"'`,
    { timeoutMs, stream: true }
  );
};

const deepReview = async (ctx: PipelineContext): Promise<void> => {
  const { config, worktreePath, options } = ctx;
  const timeoutMs = getStepTimeout(config, "deepReviewMinutes");

  // Run 3 focused review passes sequentially via codex
  const reviewPasses = [
    { focus: "correctness", prompt: `Review all changes (git diff) for BUGS and LOGIC ERRORS only: off-by-one, null/undefined, race conditions, type mismatches, missing returns, incorrect operators. Fix any issues directly. Run typecheck + build after. Do NOT create commits.` },
    { focus: "security", prompt: `Review all changes (git diff) for SECURITY ISSUES only: injection, secret exposure, auth bypasses, path traversal, unsafe operations, hardcoded credentials. Fix any issues directly. Run typecheck + build after. Do NOT create commits.` },
    { focus: "quality", prompt: `Review all changes (git diff) for CODE QUALITY only: convention violations, unnecessary complexity, DRY violations, poor naming, missing types, dead code, performance issues. Fix any issues directly. Run typecheck + build after. Do NOT create commits.` },
  ];

  for (const pass of reviewPasses) {
    const escapedPrompt = `You are reviewing code changes for ${pass.focus}.\n\nTask: ${options.task}\n\n${pass.prompt}`.replace(/'/g, "'\\''");
    await execOrThrow(
      `cd "${worktreePath}" && codex exec '${escapedPrompt}' --dangerously-bypass-approvals-and-sandbox -m ${config.codex.model} -c 'model_reasoning_effort="${config.codex.reasoningEffort}"'`,
      { timeoutMs, stream: true }
    );
  }
};
