import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { PipelineContext } from "../config";
import { exec, execOrThrow } from "../exec";
import { getStepTimeout } from "../config";

const __dirname = dirname(fileURLToPath(import.meta.url));

const loadPromptTemplate = (): string => {
  return readFileSync(join(__dirname, "..", "..", "prompts", "plan.txt"), "utf-8");
};

export const plan = async (ctx: PipelineContext): Promise<string> => {
  const { config, options, worktreePath } = ctx;

  const claudeMd = await exec(`cat "${worktreePath}/CLAUDE.md" 2>/dev/null || echo "No CLAUDE.md found"`);

  const prompt = loadPromptTemplate()
    .replace("{{task}}", options.task)
    .replace("{{claudeMd}}", claudeMd.stdout.trim());

  const escapedPrompt = prompt.replace(/'/g, "'\\''");
  const model = options.model ?? config.claude.model;
  const timeoutMs = getStepTimeout(config, "planMinutes");

  const result = await execOrThrow(
    `cd "${worktreePath}" && claude -p '${escapedPrompt}' --model ${model} --no-session-persistence`,
    { timeoutMs, stream: true }
  );

  return result.trim();
};
