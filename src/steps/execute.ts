import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { PipelineContext } from "../config";
import { exec, execOrThrow } from "../exec";
import { getStepTimeout } from "../config";
import { shellEscape } from "../shell";

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

  const timeoutMs = getStepTimeout(config, "executeMinutes");
  const effortConfig = `model_reasoning_effort="${config.codex.reasoningEffort}"`;

  await execOrThrow(
    `cd ${shellEscape(worktreePath)} && codex exec ${shellEscape(prompt)} --dangerously-bypass-approvals-and-sandbox -m ${shellEscape(config.codex.model)} -c ${shellEscape(effortConfig)}`,
    { timeoutMs, stream: true }
  );
};
