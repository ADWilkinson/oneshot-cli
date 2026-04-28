import type { PipelineContext, ComplexityMode } from "../config";
import { exec } from "../exec";
import { shellEscape } from "../shell";

export const classify = async (ctx: PipelineContext): Promise<ComplexityMode> => {
  const { worktreePath, options } = ctx;
  if (options.mode) return options.mode;

  const task = options.task;

  // Quick heuristic check first
  const fastPatterns = /\b(typo|rename|bump|version|copy|text|readme|comment|config|env|lint|format)\b/i;
  if (fastPatterns.test(task) && task.length < 100) return 'fast';

  // LLM classification via haiku (cheap, fast)
  const escapedTask = task.replace(/'/g, "'\\''");
  try {
    const result = await exec(
      `cd ${shellEscape(worktreePath)} && claude -p 'Classify this task as FAST or DEEP. Reply with ONLY one word.\n\nFAST if: typo fix, copy change, config tweak, rename, dependency bump, single-file change, simple bug fix\nDEEP if: multi-file feature, refactor, new service, complex bug, architectural change\n\nTask: ${escapedTask}' --model haiku --no-session-persistence`,
      { timeoutMs: 30_000 }
    );
    const answer = result.stdout.trim().toLowerCase();
    if (answer.includes('fast')) return 'fast';
    return 'deep';
  } catch {
    return 'deep'; // fail safe
  }
};
