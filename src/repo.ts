import { existsSync } from "fs";
import { join, resolve } from "path";
import { expandHome, isWithinRoot } from "./path-utils";

const REPO_SLUG_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export const validateRepoSlug = (repo: string): string => {
  if (!REPO_SLUG_RE.test(repo)) {
    throw new Error("repo must be in owner/repo form using only letters, numbers, dot, underscore, and hyphen");
  }
  if (repo.includes("..")) {
    throw new Error("repo must not contain '..'");
  }
  return repo;
};

/**
 * Resolve an `owner/repo` slug to a checkout path under `basePath`.
 *
 * Repos are still addressed as `owner/repo` (gh needs that anyway), but real
 * working trees are not always nested that way. We accept both layouts and
 * prefer whichever actually exists:
 *   1. nested  -> basePath/owner/repo
 *   2. flat    -> basePath/repo
 * When neither exists yet, the nested path is returned so the validate step
 * reports a clear "not found" against the canonical owner/repo location.
 */
export const resolveRepoPath = (basePath: string, repo: string): string => {
  const expandedBase = resolve(expandHome(basePath));
  validateRepoSlug(repo);
  const repoName = repo.slice(repo.indexOf("/") + 1);
  const candidates = [resolve(expandedBase, repo), resolve(expandedBase, repoName)].filter(
    (candidate) => isWithinRoot(candidate, expandedBase) && candidate !== expandedBase,
  );
  if (candidates.length === 0) {
    throw new Error(`repo path for "${repo}" is not under ${expandedBase}`);
  }
  const existingCheckout = candidates.find((candidate) => existsSync(join(candidate, ".git")));
  return existingCheckout ?? candidates[0];
};
