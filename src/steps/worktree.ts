import { resolve } from "path";
import type { PipelineContext } from "../config";
import { exec, gitRetry } from "../exec";

const WORKTREE_ROOT = "/tmp";

const sanitizeBranch = (branch: string): string => {
  // Allowlist: only alphanumeric, hyphen, underscore, dot, forward slash
  if (!/^[a-zA-Z0-9._/\-]+$/.test(branch)) {
    throw new Error(`invalid branch name: contains disallowed characters (allowed: a-z 0-9 . _ - /)`);
  }
  if (branch.includes("..")) {
    throw new Error(`invalid branch name: contains ".."`);
  }
  if (branch.startsWith("/") || branch.endsWith("/")) {
    throw new Error(`invalid branch name: starts or ends with "/"`);
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

  await gitRetry(`cd "${repoPath}" && git fetch origin '${baseBranch}'`);
  await gitRetry(
    `cd "${repoPath}" && git worktree add "${worktreePath}" 'origin/${baseBranch}' --detach`
  );
};

export const removeWorktree = async (ctx: PipelineContext): Promise<void> => {
  ensureWithinRoot(ctx.worktreePath);
  await exec(
    `cd "${ctx.repoPath}" && git worktree remove --force "${ctx.worktreePath}"`
  );
};
