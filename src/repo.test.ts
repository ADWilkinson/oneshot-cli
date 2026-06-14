import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { resolveRepoPath, validateRepoSlug } from "./repo";

describe("repo slug validation", () => {
  test("accepts owner/repo slugs", () => {
    expect(validateRepoSlug("zkp2p/zkp2p-clients")).toBe("zkp2p/zkp2p-clients");
    expect(resolveRepoPath("/srv/projects", "zkp2p/pay")).toBe("/srv/projects/zkp2p/pay");
  });

  test("rejects traversal and nested paths", () => {
    expect(() => validateRepoSlug("../secret")).toThrow("..");
    expect(() => validateRepoSlug("zkp2p/../secret")).toThrow("owner/repo");
    expect(() => validateRepoSlug("zkp2p/pay/subdir")).toThrow("owner/repo");
  });
});

describe("resolveRepoPath layout fallback", () => {
  const tempDirs: string[] = [];
  const makeBase = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "oneshot-repo-"));
    tempDirs.push(dir);
    return dir;
  };
  afterEach(() => {
    while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
  });

  test("prefers a nested owner/repo checkout when it exists", () => {
    const base = makeBase();
    mkdirSync(join(base, "acme", "widget", ".git"), { recursive: true });
    expect(resolveRepoPath(base, "acme/widget")).toBe(join(base, "acme", "widget"));
  });

  test("falls back to a flat checkout when no nested one exists", () => {
    const base = makeBase();
    mkdirSync(join(base, "widget", ".git"), { recursive: true });
    expect(resolveRepoPath(base, "acme/widget")).toBe(join(base, "widget"));
  });

  test("returns the nested path when neither layout exists", () => {
    const base = makeBase();
    expect(resolveRepoPath(base, "acme/widget")).toBe(join(base, "acme", "widget"));
  });
});
