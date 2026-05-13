import { resolve } from "path";
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

export const resolveRepoPath = (basePath: string, repo: string): string => {
  const expandedBase = resolve(expandHome(basePath));
  const repoPath = resolve(expandedBase, validateRepoSlug(repo));
  if (!isWithinRoot(repoPath, expandedBase) || repoPath === expandedBase) {
    throw new Error(`repo path "${repoPath}" is not under ${expandedBase}`);
  }
  return repoPath;
};
