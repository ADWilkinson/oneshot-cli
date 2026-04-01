import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { PipelineContext } from "../config";
import { execOrThrow, exec } from "../exec";
import { getStepTimeout } from "../config";
import { shellEscape } from "../shell";

const __dirname = dirname(fileURLToPath(import.meta.url));

const loadPromptTemplate = (): string => {
  return readFileSync(join(__dirname, "..", "..", "prompts", "pr.txt"), "utf-8");
};

export const getPrModel = (ctx: PipelineContext): string =>
  ctx.options.model ?? ctx.config.claude.model;

/**
 * Create a draft PR with all current changes committed and pushed.
 * Returns the PR URL. The PR is created as draft so review can push fixes on top.
 */
export const createDraftPr = async (ctx: PipelineContext): Promise<string> => {
  const { config, options, worktreePath } = ctx;

  const branchSlug = options.linearIssueId
    ? options.linearIssueId.toLowerCase()
    : slugify(options.taskSummary ?? options.task) || "task";
  const branchName = `oneshot/${branchSlug}-${Date.now()}`;
  const baseBranch = options.branch ?? "main";
  const taskSummary = options.taskSummary ?? options.task;

  const model = getPrModel(ctx);
  const prompt = loadPromptTemplate()
    .replace("{{task}}", taskSummary)
    .replace("{{branchName}}", branchName)
    .replace(/\{\{baseBranch\}\}/g, baseBranch);

  const timeoutMs = getStepTimeout(config, "prMinutes");

  const result = await execOrThrow(
    `cd ${shellEscape(worktreePath)} && claude -p ${shellEscape(prompt)} --dangerously-skip-permissions --model ${shellEscape(model)} --no-session-persistence`,
    { timeoutMs, stream: true }
  );

  const prUrlMatch = result.match(/PR_URL:\s*(https:\/\/github\.com\/\S+)/);
  if (prUrlMatch) return prUrlMatch[1];

  const urlMatch = result.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
  if (urlMatch) return urlMatch[0];

  throw new Error("could not extract PR URL from claude output");
};

/**
 * After review, commit any fixes and push. Then mark the PR as ready.
 * If review made no changes, just marks the PR as ready.
 */
export const finalizeAfterReview = async (ctx: PipelineContext): Promise<void> => {
  const { worktreePath, prUrl } = ctx;

  // Check if review made any changes
  const diff = await exec(`cd ${shellEscape(worktreePath)} && git diff --stat`);
  const untracked = await exec(
    `cd ${shellEscape(worktreePath)} && git ls-files --others --exclude-standard`
  );
  const hasChanges = !!(diff.stdout.trim() || untracked.stdout.trim());

  if (hasChanges) {
    // Stage, commit, and push review fixes
    await execOrThrow(`cd ${shellEscape(worktreePath)} && git add -A`);
    await execOrThrow(`cd ${shellEscape(worktreePath)} && git commit -m "fix: address review findings"`);
    await execOrThrow(`cd ${shellEscape(worktreePath)} && git push`);
  }

  // Mark the PR as ready (remove draft status)
  const prNumber = prUrl.match(/\/pull\/(\d+)/)?.[1];
  if (!prNumber) throw new Error(`could not extract PR number from URL: ${prUrl}`);
  await execOrThrow(`cd ${shellEscape(worktreePath)} && gh pr ready ${shellEscape(prNumber)}`);
};

export const getFilesChanged = async (ctx: PipelineContext): Promise<number> => {
  const baseBranch = ctx.options.branch ?? "main";
  const result = await execOrThrow(
    `cd ${shellEscape(ctx.worktreePath)} && git diff --stat ${shellEscape(`origin/${baseBranch}...HEAD`)} | tail -1`
  );
  const match = result.match(/(\d+) files? changed/);
  return match ? parseInt(match[1], 10) : 0;
};

export const getDiffStats = async (ctx: PipelineContext): Promise<Array<{ file: string; additions: number; deletions: number }>> => {
  try {
    const baseBranch = ctx.options.branch ?? "main";
    const result = await execOrThrow(
      `cd ${shellEscape(ctx.worktreePath)} && git diff --numstat ${shellEscape(`origin/${baseBranch}...HEAD`)}`
    );
    return result.trim().split('\n').filter(Boolean).map(line => {
      const [add, del, file] = line.split('\t');
      return { file, additions: parseInt(add, 10) || 0, deletions: parseInt(del, 10) || 0 };
    });
  } catch {
    return [];
  }
};

const slugify = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
