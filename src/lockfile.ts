import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";

const LOCK_DIR = join(process.env.HOME ?? "/root", ".oneshot", "locks");

const repoHash = (repo: string): string =>
  createHash("sha256").update(repo).digest("hex").slice(0, 12);

const lockPath = (repo: string): string => {
  mkdirSync(LOCK_DIR, { recursive: true });
  return join(LOCK_DIR, `${repoHash(repo)}.lock`);
};

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const acquireRepoLock = (repo: string): (() => void) => {
  const path = lockPath(repo);

  if (existsSync(path)) {
    try {
      const lock = JSON.parse(readFileSync(path, "utf-8"));
      if (lock.pid && isPidAlive(lock.pid)) {
        throw new Error(
          `repo "${repo}" is already locked by PID ${lock.pid} (started ${new Date(lock.timestamp).toISOString()}). ` +
          `if this is stale, delete ${path}`
        );
      }
      // stale lock - remove it
    } catch (err) {
      if (err instanceof Error && err.message.includes("already locked")) throw err;
      // corrupted lock file - remove it
    }
  }

  writeFileSync(path, JSON.stringify({ pid: process.pid, repo, timestamp: Date.now() }));

  return () => {
    try { unlinkSync(path); } catch { /* already removed */ }
  };
};
