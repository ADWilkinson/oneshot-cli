import { readFileSync } from "fs";
import { join } from "path";
import type { PipelineContext } from "../config";
import { exec } from "../exec";
import { getStepTimeout } from "../config";
import { shellEscape } from "../shell";
import { PROMPTS_DIR } from "../paths";
import type { EventWriter } from "../events";
import { runCodexJson } from "../codex-runner";
import { runAgentText } from "../phase-runner";
import { getRoutedPhaseAgent } from "../routing";
import { fillTemplate } from "../template";

const loadPromptTemplate = (): string => {
  return readFileSync(join(PROMPTS_DIR, "execute.txt"), "utf-8");
};

export const execute = async (ctx: PipelineContext, events: EventWriter): Promise<void> => {
  const { config, options, worktreePath } = ctx;

  const claudeMd = await exec(`cat ${shellEscape(`${worktreePath}/CLAUDE.md`)} 2>/dev/null || echo "No CLAUDE.md found"`);

  const prompt = fillTemplate(loadPromptTemplate(), {
    task: options.task,
    plan: ctx.plan,
    claudeMd: claudeMd.stdout.trim(),
  });

  const timeoutMs = getStepTimeout(config, "executeMinutes");
  const agent = getRoutedPhaseAgent(config, "execute", ctx.route);

  if (agent.provider === "claude") {
    await runAgentText({
      worktreePath,
      prompt,
      agent,
      timeoutMs,
      allowClaudeWrites: true,
    });
    return;
  }

  await runCodexJson({
    worktreePath,
    prompt,
    model: agent.model,
    reasoningEffort: agent.reasoningEffort ?? "xhigh",
    timeoutMs,
    step: 5,
    events,
  });
};
