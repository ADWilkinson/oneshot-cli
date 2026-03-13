import type { PipelineContext } from "../config";
import { exec, execOrThrow, gitRetry } from "../exec";
import { log } from "../log";

/** Read packageManager field from package.json if present (e.g. "yarn@3.6.4") */
const getPackageManagerSpec = async (
  dir: string
): Promise<{ name: string; version: string } | null> => {
  const { stdout, exitCode } = await exec(
    `cat "${dir}/package.json" 2>/dev/null`
  );
  if (exitCode !== 0 || !stdout.trim()) return null;
  try {
    const pkg = JSON.parse(stdout);
    if (!pkg.packageManager) return null;
    const [name, version] = pkg.packageManager.split("@");
    return name && version ? { name, version } : null;
  } catch {
    return null;
  }
};

/** Build the install command based on lockfile and packageManager field */
const resolveInstallCmd = async (
  dir: string,
  lockfiles: string
): Promise<string | null> => {
  if (lockfiles.includes("bun.lock")) {
    return "bun install --frozen-lockfile";
  }

  if (lockfiles.includes("pnpm-lock.yaml")) {
    return "pnpm install --frozen-lockfile";
  }

  if (lockfiles.includes("yarn.lock")) {
    const spec = await getPackageManagerSpec(dir);
    const major = spec?.name === "yarn" ? parseInt(spec.version) : 1;
    // Yarn 2+ (Berry) uses --immutable, Yarn 1 (Classic) uses --frozen-lockfile
    return major >= 2
      ? "yarn install --immutable"
      : "yarn install --frozen-lockfile";
  }

  if (lockfiles.includes("package-lock.json")) {
    return "npm ci";
  }

  return null;
};

export const createWorktree = async (ctx: PipelineContext): Promise<void> => {
  const { repoPath, worktreePath } = ctx;

  const baseBranch = ctx.options.branch ?? "main";
  await gitRetry(`cd "${repoPath}" && git fetch origin ${baseBranch}`);
  await gitRetry(
    `cd "${repoPath}" && git worktree add "${worktreePath}" origin/${baseBranch} --detach`
  );

  // Auto-detect package manager and install deps
  const { stdout: lockfiles } = await exec(
    `ls "${worktreePath}/bun.lockb" "${worktreePath}/bun.lock" "${worktreePath}/pnpm-lock.yaml" "${worktreePath}/yarn.lock" "${worktreePath}/package-lock.json" 2>/dev/null`
  );

  if (!lockfiles.trim()) {
    log.info("no lockfile found, skipping dependency install");
    return;
  }

  const installCmd = await resolveInstallCmd(worktreePath, lockfiles);
  if (!installCmd) {
    log.info("no recognized lockfile, skipping dependency install");
    return;
  }

  // Enable corepack if package.json declares packageManager (Yarn 2+, pnpm via corepack, etc.)
  const spec = await getPackageManagerSpec(worktreePath);
  const needsCorepack =
    spec && (spec.name === "yarn" ? parseInt(spec.version) >= 2 : false);

  const prefix = needsCorepack ? "corepack enable && " : "";

  log.info(
    `installing deps with: ${needsCorepack ? "[corepack] " : ""}${installCmd}`
  );

  try {
    await execOrThrow(`cd "${worktreePath}" && ${prefix}${installCmd}`, {
      timeoutMs: 180_000,
    });
  } catch (err) {
    // Non-fatal: agent can often still work without node_modules
    log.warn(`dependency install failed (continuing anyway): ${err}`);
  }
};

export const removeWorktree = async (ctx: PipelineContext): Promise<void> => {
  await exec(
    `cd "${ctx.repoPath}" && git worktree remove --force "${ctx.worktreePath}"`
  );
};
