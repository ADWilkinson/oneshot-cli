import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { PipelineContext } from "../config";
import { execOrThrow } from "../exec";
import { getStepTimeout } from "../config";

const __dirname = dirname(fileURLToPath(import.meta.url));

const loadPromptTemplate = (): string => {
  return readFileSync(join(__dirname, "..", "..", "prompts", "review.txt"), "utf-8");
};

export const review = async (ctx: PipelineContext): Promise<void> => {
  const { config, options, worktreePath } = ctx;

  // Quick check that there are changes to review
  const diff = await execOrThrow(`cd "${worktreePath}" && git diff --stat`);
  if (!diff.trim()) throw new Error("no changes were made during execution step");

  // Don't pass the diff inline -- let Codex read it via git diff itself
  const prompt = loadPromptTemplate()
    .replace("{{task}}", options.task);

  const escapedPrompt = prompt.replace(/'/g, "'\\''");
  const timeoutMs = getStepTimeout(config, "reviewMinutes");

  await execOrThrow(
    `cd "${worktreePath}" && codex exec '${escapedPrompt}' --dangerously-bypass-approvals-and-sandbox -m ${config.codex.model} -c 'model_reasoning_effort="${config.codex.reasoningEffort}"'`,
    { timeoutMs, stream: true }
  );
};
