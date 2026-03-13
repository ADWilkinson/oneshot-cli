import type { PipelineContext } from "../config";
import { exec, gitRetry } from "../exec";

export const createWorktree = async (ctx: PipelineContext): Promise<void> => {
  const { repoPath, worktreePath } = ctx;

  const baseBranch = ctx.options.branch ?? "main";
  await gitRetry(`cd "${repoPath}" && git fetch origin ${baseBranch}`);
  await gitRetry(
    `cd "${repoPath}" && git worktree add "${worktreePath}" origin/${baseBranch} --detach`
  );
};

export const removeWorktree = async (ctx: PipelineContext): Promise<void> => {
  await exec(
    `cd "${ctx.repoPath}" && git worktree remove --force "${ctx.worktreePath}"`
  );
};
