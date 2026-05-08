import { execOrThrow } from "./exec";
import { log } from "./log";
import { getStepLabel } from "./pipeline-steps";
import { shellEscape } from "./shell";
import { translateCodexJsonLine } from "./codex-events";
import type { EventWriter, AgentActionPayload } from "./events";

interface RunCodexJsonOptions {
  worktreePath: string;
  prompt: string;
  model: string;
  reasoningEffort: string;
  timeoutMs: number;
  step: number;
  events: EventWriter;
}

const shouldEchoAction = (action: AgentActionPayload): boolean =>
  action.phase === "completed" &&
  (action.kind === "command" ||
    action.kind === "file_change" ||
    action.kind === "todo" ||
    action.kind === "tool" ||
    action.kind === "warning" ||
    action.kind === "web_search");

export const buildCodexExecCommand = (opts: {
  worktreePath: string;
  prompt: string;
  model: string;
  reasoningEffort: string;
}): string => {
  const effortConfig = `model_reasoning_effort="${opts.reasoningEffort}"`;
  return [
    `cd ${shellEscape(opts.worktreePath)} &&`,
    "codex exec",
    "--json",
    "--color=never",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "-m",
    shellEscape(opts.model),
    "-c",
    shellEscape(effortConfig),
    shellEscape(opts.prompt),
  ].join(" ");
};

export const runCodexJson = async (opts: RunCodexJsonOptions): Promise<void> => {
  const label = getStepLabel(opts.step);

  await execOrThrow(
    buildCodexExecCommand(opts),
    {
      timeoutMs: opts.timeoutMs,
      stream: true,
      streamStdout: false,
      onStdoutLine: (line) => {
        for (const action of translateCodexJsonLine(line)) {
          opts.events.agentAction(opts.step, label, action);
          if (shouldEchoAction(action)) {
            log.info(`codex ${action.kind}: ${action.title}`);
          }
        }
      },
    }
  );
};
