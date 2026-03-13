import { existsSync, readFileSync, unlinkSync, mkdirSync, openSync, writeSync, closeSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";

const LOCK_DIR = join(process.env.HOME ?? "/root", ".oneshot", "locks");

const repoHash = (repo: string): string =>
  createHash("sha256").update(repo).digest("hex").slice(0, 12);

const lockPath = (repo: string): string =>
  join(LOCK_DIR, `${repoHash(repo)}.lock`);

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const acquireRepoLock = (repo: string): (() => void) => {
  mkdirSync(LOCK_DIR, { recursive: true });
  const path = lockPath(repo);

  // Check for stale lock from a dead process
  if (existsSync(path)) {
    try {
      const lock = JSON.parse(readFileSync(path, "utf-8"));
      if (lock.pid && isPidAlive(lock.pid)) {
        throw new Error(
          `repo "${repo}" is already locked by PID ${lock.pid} (started ${new Date(lock.timestamp).toISOString()}). ` +
          `if this is stale, delete ${path}`
        );
      }
      unlinkSync(path);
    } catch (err) {
      if (err instanceof Error && err.message.includes("already locked")) throw err;
      try { unlinkSync(path); } catch { /* already gone */ }
    }
  }

  // Atomic create with O_EXCL to prevent TOCTOU race
  try {
    const fd = openSync(path, "wx");
    writeSync(fd, JSON.stringify({ pid: process.pid, repo, timestamp: Date.now() }));
    closeSync(fd);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`repo "${repo}" lock acquired by another process between check and create`);
    }
    throw err;
  }

  return () => {
    try { unlinkSync(path); } catch { /* already removed */ }
  };
};
