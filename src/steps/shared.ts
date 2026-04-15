import { readFileSync } from "fs";
import { join } from "path";
import type { PipelineContext } from "../config";
import { exec } from "../exec";
import { shellEscape } from "../shell";
import { PROMPTS_DIR, CLAUDE_PLUGIN_DIR } from "../paths";

export const loadPromptTemplate = (name: string): string =>
  readFileSync(join(PROMPTS_DIR, name), "utf-8");

export const readClaudeMd = async (worktreePath: string): Promise<string> => {
  const result = await exec(`cat "${worktreePath}/CLAUDE.md" 2>/dev/null || echo "No CLAUDE.md found"`);
  return result.stdout.trim();
};

/** Trailing-space-delimited `--plugin-dir …` fragment when configured, else "". */
export const getPluginFlag = (): string =>
  CLAUDE_PLUGIN_DIR ? `--plugin-dir ${shellEscape(CLAUDE_PLUGIN_DIR)} ` : "";

export const codexEffortConfig = (effort: string): string =>
  `model_reasoning_effort="${effort}"`;

export const getReviewModel = (ctx: PipelineContext): string =>
  ctx.config.codex.reviewModel ?? "gpt-5.4-mini";

export const getReviewEffort = (ctx: PipelineContext): string =>
  ctx.config.codex.reviewReasoningEffort ?? "xhigh";
