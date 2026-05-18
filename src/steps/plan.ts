import { readFileSync } from "fs";
import { join } from "path";
import type { PipelineContext } from "../config";
import { exec } from "../exec";
import { getPhaseAgent, getStepTimeout } from "../config";
import { shellEscape } from "../shell";
import { PROMPTS_DIR } from "../paths";
import { runAgentText, withModelOverride } from "../phase-runner";

const loadPromptTemplate = (): string => {
  return readFileSync(join(PROMPTS_DIR, "plan.txt"), "utf-8");
};

export const plan = async (ctx: PipelineContext): Promise<string> => {
  const { config, options, worktreePath } = ctx;

  const claudeMd = await exec(`cat ${shellEscape(`${worktreePath}/CLAUDE.md`)} 2>/dev/null || echo "No CLAUDE.md found"`);

  const prompt = loadPromptTemplate()
    .replace("{{task}}", options.task)
    .replace("{{claudeMd}}", claudeMd.stdout.trim());

  const agent = withModelOverride(
    getPhaseAgent(config, "plan"),
    options.model,
  );
  const timeoutMs = getStepTimeout(config, "planMinutes");

  const result = await runAgentText({
    worktreePath,
    prompt,
    agent,
    timeoutMs,
    includeClaudePlugins: true,
  });

  return result.trim();
};
