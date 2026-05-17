import type { PipelineContext, ComplexityMode } from "../config";
import { getPhaseAgent } from "../config";
import { runAgentText } from "../phase-runner";

export const classify = async (ctx: PipelineContext): Promise<ComplexityMode> => {
  const { worktreePath, options } = ctx;
  if (options.mode) return options.mode;

  const task = options.task;

  // Quick heuristic check first
  const fastPatterns = /\b(typo|rename|bump|version|copy|text|readme|comment|config|env|lint|format)\b/i;
  if (fastPatterns.test(task) && task.length < 100) return 'fast';

  // LLM classification uses the configured classify phase agent.
  try {
    const result = await runAgentText({
      worktreePath,
      prompt: `Classify this task as FAST or DEEP. Reply with ONLY one word.

FAST if: typo fix, copy change, config tweak, rename, dependency bump, single-file change, simple bug fix
DEEP if: multi-file feature, refactor, new service, complex bug, architectural change

Task: ${task}`,
      agent: getPhaseAgent(ctx.config, "classify"),
      timeoutMs: 30_000,
    });
    const answer = result.trim().toLowerCase();
    if (answer.includes('fast')) return 'fast';
    return 'deep';
  } catch {
    return 'deep'; // fail safe
  }
};
