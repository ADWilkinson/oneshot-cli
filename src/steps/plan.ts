import { readFileSync } from "fs";
import { join } from "path";
import type { PipelineContext } from "../config";
import { exec, execOrThrow } from "../exec";
import { getStepTimeout } from "../config";
import { shellEscape } from "../shell";
import { PROMPTS_DIR, CLAUDE_PLUGIN_DIR } from "../paths";

const loadPromptTemplate = (): string => {
  return readFileSync(join(PROMPTS_DIR, "plan.txt"), "utf-8");
};

const pluginFlag = CLAUDE_PLUGIN_DIR
  ? `--plugin-dir ${shellEscape(CLAUDE_PLUGIN_DIR)} `
  : "";

export const plan = async (ctx: PipelineContext): Promise<string> => {
  const { config, options, worktreePath } = ctx;

  const claudeMd = await exec(`cat ${shellEscape(`${worktreePath}/CLAUDE.md`)} 2>/dev/null || echo "No CLAUDE.md found"`);

  const prompt = loadPromptTemplate()
    .replace("{{task}}", options.task)
    .replace("{{claudeMd}}", claudeMd.stdout.trim());

  const model = options.model ?? config.claude.model;
  const timeoutMs = getStepTimeout(config, "planMinutes");

  const result = await execOrThrow(
    `cd ${shellEscape(worktreePath)} && claude -p ${shellEscape(prompt)} ${pluginFlag}--model ${shellEscape(model)} --no-session-persistence`,
    { timeoutMs, stream: true }
  );

  return result.trim();
};
