import { mkdirSync } from "fs";
import { resolve } from "path";
import type { PipelineContext } from "../config";
import { exec, gitRetry } from "../exec";
import { shellEscape } from "../shell";
import { isWithinRoot } from "../path-utils";

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

const ensureWithinRoot = (worktreePath: string, root: string): void => {
  const resolved = resolve(worktreePath);
  const resolvedRoot = resolve(root);
  if (!isWithinRoot(resolved, resolvedRoot) || resolved === resolvedRoot) {
    throw new Error(
      `worktree path "${resolved}" is not under ${resolvedRoot} -- possible path traversal`
    );
  }
};

export const createWorktree = async (ctx: PipelineContext): Promise<void> => {
  const { repoPath, worktreePath } = ctx;

  const baseBranch = sanitizeBranch(ctx.options.branch ?? "main");
  ensureWithinRoot(worktreePath, ctx.worktreeRoot);
  mkdirSync(ctx.worktreeRoot, { recursive: true });

  await gitRetry(`cd ${shellEscape(repoPath)} && git fetch origin ${shellEscape(baseBranch)}`);
  await gitRetry(
    `cd ${shellEscape(repoPath)} && git worktree add ${shellEscape(worktreePath)} ${shellEscape(`origin/${baseBranch}`)} --detach`
  );
};

export const removeWorktree = async (ctx: PipelineContext): Promise<void> => {
  ensureWithinRoot(ctx.worktreePath, ctx.worktreeRoot);
  await exec(
    `cd ${shellEscape(ctx.repoPath)} && git worktree remove --force ${shellEscape(ctx.worktreePath)}`
  );
};
