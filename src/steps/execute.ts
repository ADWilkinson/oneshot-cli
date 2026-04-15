import type { PipelineContext } from "../config";
import { execOrThrow } from "../exec";
import { getStepTimeout } from "../config";
import { shellEscape } from "../shell";
import { codexEffortConfig, loadPromptTemplate, readClaudeMd } from "./shared";

export const execute = async (ctx: PipelineContext): Promise<void> => {
  const { config, options, worktreePath } = ctx;

  const claudeMd = await readClaudeMd(worktreePath);

  const prompt = loadPromptTemplate("execute.txt")
    .replace("{{task}}", options.task)
    .replace("{{plan}}", ctx.plan)
    .replace("{{claudeMd}}", claudeMd);

  const timeoutMs = getStepTimeout(config, "executeMinutes");

  await execOrThrow(
    `cd ${shellEscape(worktreePath)} && codex exec ${shellEscape(prompt)} --dangerously-bypass-approvals-and-sandbox -m ${shellEscape(config.codex.model)} -c ${shellEscape(codexEffortConfig(config.codex.reasoningEffort))}`,
    { timeoutMs, stream: true }
  );
};
