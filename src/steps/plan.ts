import type { PipelineContext } from "../config";
import { execOrThrow } from "../exec";
import { getStepTimeout } from "../config";
import { shellEscape } from "../shell";
import { getPluginFlag, loadPromptTemplate, readClaudeMd } from "./shared";

export const plan = async (ctx: PipelineContext): Promise<string> => {
  const { config, options, worktreePath } = ctx;

  const claudeMd = await readClaudeMd(worktreePath);

  const prompt = loadPromptTemplate("plan.txt")
    .replace("{{task}}", options.task)
    .replace("{{claudeMd}}", claudeMd);

  const model = options.model ?? config.claude.model;
  const timeoutMs = getStepTimeout(config, "planMinutes");

  const result = await execOrThrow(
    `cd ${shellEscape(worktreePath)} && claude -p ${shellEscape(prompt)} ${getPluginFlag()}--model ${shellEscape(model)} --no-session-persistence`,
    { timeoutMs, stream: true }
  );

  return result.trim();
};
