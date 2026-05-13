import { describe, expect, test } from "bun:test";
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
