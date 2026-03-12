import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { PipelineContext } from "../config";
import { execOrThrow } from "../exec";
import { getStepTimeout } from "../config";

const __dirname = dirname(fileURLToPath(import.meta.url));

const loadPromptTemplate = (): string => {
  return readFileSync(join(__dirname, "..", "..", "prompts", "pr.txt"), "utf-8");
};

export const createPr = async (ctx: PipelineContext): Promise<string> => {
  const { config, options, worktreePath } = ctx;

  const branchSlug = options.linearIssueId
    ? options.linearIssueId.toLowerCase()
    : slugify(options.taskSummary ?? options.task);
  const branchName = `oneshot/${branchSlug}-${Date.now()}`;
  const model = options.model ?? config.claude.model;

  const baseBranch = options.branch ?? "main";
  const prompt = loadPromptTemplate()
    .replace("{{task}}", options.taskSummary ?? options.task)
    .replace("{{branchName}}", branchName)
    .replace(/\{\{baseBranch\}\}/g, baseBranch);

  const escapedPrompt = prompt.replace(/'/g, "'\\''");
  const timeoutMs = getStepTimeout(config, "prMinutes");

  const result = await execOrThrow(
    `cd "${worktreePath}" && claude -p '${escapedPrompt}' --dangerously-skip-permissions --model ${model} --no-session-persistence`,
    { timeoutMs, stream: true }
  );

  const prUrlMatch = result.match(/PR_URL:\s*(https:\/\/github\.com\/\S+)/);
  if (prUrlMatch) return prUrlMatch[1];

  const urlMatch = result.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
  if (urlMatch) return urlMatch[0];

  throw new Error("could not extract PR URL from claude output");
};

export const getFilesChanged = async (ctx: PipelineContext): Promise<number> => {
  const result = await execOrThrow(`cd "${ctx.worktreePath}" && git diff --stat HEAD~1 | tail -1`);
  const match = result.match(/(\d+) files? changed/);
  return match ? parseInt(match[1], 10) : 0;
};

const slugify = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
