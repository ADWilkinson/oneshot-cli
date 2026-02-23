import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { PipelineContext } from "../config";
import { exec, execOrThrow } from "../exec";
import { getStepTimeout } from "../config";

const __dirname = dirname(fileURLToPath(import.meta.url));

const loadPromptTemplate = (): string => {
  return readFileSync(join(__dirname, "..", "..", "prompts", "execute.txt"), "utf-8");
};

export const execute = async (ctx: PipelineContext): Promise<void> => {
  const { config, options, worktreePath } = ctx;

  const claudeMd = await exec(`cat "${worktreePath}/CLAUDE.md" 2>/dev/null || echo "No CLAUDE.md found"`);

  const prompt = loadPromptTemplate()
    .replace("{{task}}", options.task)
    .replace("{{plan}}", ctx.plan)
    .replace("{{claudeMd}}", claudeMd.stdout.trim());

  const escapedPrompt = prompt.replace(/'/g, "'\\''");
  const timeoutMs = getStepTimeout(config, "executeMinutes");

  await execOrThrow(
    `cd "${worktreePath}" && codex exec '${escapedPrompt}' --dangerously-bypass-approvals-and-sandbox -m ${config.codex.model} -c 'model_reasoning_effort="${config.codex.reasoningEffort}"'`,
    { timeoutMs, stream: true }
  );
};
