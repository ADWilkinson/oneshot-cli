import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { exec } from "./exec";
import { shellEscape } from "./shell";
import type { PipelineContext } from "./config";

export interface OneshotPolicy {
  version: 1;
  protectedPaths: string[];
  requiredChecks: string[];
  requireApprovalFor: string[];
  secretPatterns: string[];
}

export const DEFAULT_POLICY: OneshotPolicy = {
  version: 1,
  protectedPaths: [
    ".env",
    ".env.*",
    "**/*.pem",
    "**/*.key",
    "package-lock.json",
  ],
  requiredChecks: [],
  requireApprovalFor: [
    "deploy",
    "publish",
    "migration",
    "production",
  ],
  secretPatterns: [
    "sk-[A-Za-z0-9_-]{20,}",
    "xox[baprs]-[A-Za-z0-9-]{20,}",
    "gh[pousr]_[A-Za-z0-9_]{20,}",
  ],
};

export const POLICY_PATH = ".oneshot/policy.json";

export const loadPolicy = (repoPath: string): OneshotPolicy | null => {
  const path = join(repoPath, POLICY_PATH);
  if (!existsSync(path)) return null;
  let raw: Partial<OneshotPolicy>;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<OneshotPolicy>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`invalid policy JSON in ${path}: ${msg}`);
  }
  return {
    version: 1,
    protectedPaths: Array.isArray(raw.protectedPaths) ? raw.protectedPaths.filter(Boolean) : DEFAULT_POLICY.protectedPaths,
    requiredChecks: Array.isArray(raw.requiredChecks) ? raw.requiredChecks.filter(Boolean) : [],
    requireApprovalFor: Array.isArray(raw.requireApprovalFor) ? raw.requireApprovalFor.filter(Boolean) : DEFAULT_POLICY.requireApprovalFor,
    secretPatterns: Array.isArray(raw.secretPatterns) ? raw.secretPatterns.filter(Boolean) : DEFAULT_POLICY.secretPatterns,
  };
};

export const initPolicy = (targetDir = process.cwd()): string => {
  const path = join(targetDir, POLICY_PATH);
  if (existsSync(path)) return path;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(DEFAULT_POLICY, null, 2) + "\n");
  return path;
};

const globToRegex = (pattern: string): RegExp => {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`);
};

const matchesAny = (path: string, patterns: string[]): string | undefined => {
  return patterns.find((pattern) => globToRegex(pattern).test(path));
};

export interface PolicyValidationResult {
  ok: boolean;
  warnings: string[];
  failures: string[];
}

export const validatePolicy = async (ctx: PipelineContext): Promise<PolicyValidationResult> => {
  const policy = loadPolicy(ctx.worktreePath);
  if (!policy) return { ok: true, warnings: [], failures: [] };

  const warnings: string[] = [];
  const failures: string[] = [];
  const changed = await exec(`cd ${shellEscape(ctx.worktreePath)} && git diff --name-only --cached && git diff --name-only && git ls-files --others --exclude-standard`, {
    timeoutMs: 60_000,
  });
  const changedFiles = Array.from(new Set(changed.stdout.split("\n").map((line) => line.trim()).filter(Boolean)));

  for (const file of changedFiles) {
    const match = matchesAny(file, policy.protectedPaths);
    if (match) failures.push(`protected path changed: ${file} (${match})`);
  }

  if (policy.secretPatterns.length > 0) {
    const diff = await exec(`cd ${shellEscape(ctx.worktreePath)} && git diff --cached --unified=0 && git diff --unified=0`, {
      timeoutMs: 60_000,
    });
    for (const pattern of policy.secretPatterns) {
      const re = new RegExp(pattern);
      if (re.test(diff.stdout)) failures.push(`secret-like diff matched policy pattern: ${pattern}`);
    }
  }

  const taskText = `${ctx.options.task} ${ctx.options.taskSummary ?? ""}`.toLowerCase();
  for (const word of policy.requireApprovalFor) {
    if (taskText.includes(word.toLowerCase())) {
      warnings.push(`approval-sensitive task keyword matched policy: ${word}`);
    }
  }

  for (const command of policy.requiredChecks) {
    const result = await exec(`cd ${shellEscape(ctx.worktreePath)} && ${command}`, {
      timeoutMs: 30 * 60 * 1000,
    });
    if (result.exitCode !== 0) failures.push(`required check failed: ${command}`);
  }

  return { ok: failures.length === 0, warnings, failures };
};
