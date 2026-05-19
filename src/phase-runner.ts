import type { PhaseAgentConfig } from "./config";
import { execOrThrow } from "./exec";
import { shellEscape } from "./shell";
import { internalClaudeFlags } from "./claude-flags";
import { CLAUDE_PLUGIN_DIR } from "./paths";
import { runCodexText } from "./codex-runner";

const pluginFlag = CLAUDE_PLUGIN_DIR
  ? `--plugin-dir ${shellEscape(CLAUDE_PLUGIN_DIR)} `
  : "";

export const withModelOverride = (
  agent: PhaseAgentConfig,
  modelOverride: string | undefined,
): PhaseAgentConfig => {
  if (!modelOverride) return agent;
  return { ...agent, model: modelOverride };
};

export const runAgentText = async (opts: {
  worktreePath: string;
  prompt: string;
  agent: PhaseAgentConfig;
  timeoutMs: number;
  includeClaudePlugins?: boolean;
  allowClaudeWrites?: boolean;
}): Promise<string> => {
  if (opts.agent.provider === "codex") {
    return runCodexText({
      worktreePath: opts.worktreePath,
      prompt: opts.prompt,
      model: opts.agent.model,
      reasoningEffort: opts.agent.reasoningEffort ?? "xhigh",
      timeoutMs: opts.timeoutMs,
    });
  }

  const writeFlag = opts.allowClaudeWrites ? " --dangerously-skip-permissions" : "";
  const effortFlag = opts.agent.reasoningEffort
    ? ` --effort ${shellEscape(opts.agent.reasoningEffort)}`
    : "";
  const plugins = opts.includeClaudePlugins ? pluginFlag : "";
  return execOrThrow(
    `cd ${shellEscape(opts.worktreePath)} && claude -p ${shellEscape(opts.prompt)} ${plugins}${internalClaudeFlags()}${writeFlag}${effortFlag} --model ${shellEscape(opts.agent.model)} --no-session-persistence`,
    { timeoutMs: opts.timeoutMs, stream: true }
  );
};
