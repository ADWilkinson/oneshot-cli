import { resolve } from "path";
import type { PipelineContext } from "../config";
import { exec, gitRetry } from "../exec";

const WORKTREE_ROOT = "/tmp";

const sanitizeBranch = (branch: string): string => {
  if (branch.includes("..")) {
    throw new Error(`invalid branch name: contains ".."`);
  }
  if (branch.startsWith("/")) {
    throw new Error(`invalid branch name: starts with "/"`);
  }
  // reject control characters (U+0000 through U+001F and U+007F)
  if (/[\x00-\x1f\x7f]/.test(branch)) {
    throw new Error("invalid branch name: contains control characters");
  }
  return branch;
};

const ensureWithinRoot = (worktreePath: string): void => {
  const resolved = resolve(worktreePath);
  if (!resolved.startsWith(WORKTREE_ROOT + "/")) {
    throw new Error(
      `worktree path "${resolved}" is not under ${WORKTREE_ROOT} -- possible path traversal`
    );
  }
};

export const createWorktree = async (ctx: PipelineContext): Promise<void> => {
  const { repoPath, worktreePath } = ctx;

  const baseBranch = sanitizeBranch(ctx.options.branch ?? "main");
  ensureWithinRoot(worktreePath);

  await gitRetry(`cd "${repoPath}" && git fetch origin ${baseBranch}`);
  await gitRetry(
    `cd "${repoPath}" && git worktree add "${worktreePath}" origin/${baseBranch} --detach`
  );
};

export const removeWorktree = async (ctx: PipelineContext): Promise<void> => {
  ensureWithinRoot(ctx.worktreePath);
  await exec(
    `cd "${ctx.repoPath}" && git worktree remove --force "${ctx.worktreePath}"`
  );
};
