import type { PipelineContext } from "../config";
import { exec, execOrThrow, gitRetry } from "../exec";
import { log } from "../log";

export const createWorktree = async (ctx: PipelineContext): Promise<void> => {
  const { repoPath, worktreePath } = ctx;

  const baseBranch = ctx.options.branch ?? "main";
  await gitRetry(`cd "${repoPath}" && git fetch origin ${baseBranch}`);
  await gitRetry(`cd "${repoPath}" && git worktree add "${worktreePath}" origin/${baseBranch} --detach`);

  // Auto-detect package manager and install deps
  const { stdout: lockfiles } = await exec(
    `ls "${worktreePath}/bun.lockb" "${worktreePath}/bun.lock" "${worktreePath}/pnpm-lock.yaml" "${worktreePath}/yarn.lock" "${worktreePath}/package-lock.json" 2>/dev/null`
  );

  if (!lockfiles.trim()) {
    log.info("no lockfile found, skipping dependency install");
    return;
  }

  let installCmd: string;
  if (lockfiles.includes("bun.lock")) {
    installCmd = "bun install --frozen-lockfile";
  } else if (lockfiles.includes("pnpm-lock.yaml")) {
    installCmd = "pnpm install --frozen-lockfile";
  } else if (lockfiles.includes("yarn.lock")) {
    installCmd = "yarn install --frozen-lockfile";
  } else if (lockfiles.includes("package-lock.json")) {
    installCmd = "npm ci";
  } else {
    log.info("no recognized lockfile, skipping dependency install");
    return;
  }

  log.info(`installing deps with: ${installCmd}`);
  await execOrThrow(`cd "${worktreePath}" && ${installCmd}`, { timeoutMs: 120_000 });
};

export const removeWorktree = async (ctx: PipelineContext): Promise<void> => {
  await exec(`cd "${ctx.repoPath}" && git worktree remove --force "${ctx.worktreePath}"`);
};
