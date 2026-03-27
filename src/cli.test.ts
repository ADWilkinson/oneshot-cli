import { describe, expect, test } from "bun:test";
import { buildLocalChildArgs, buildRemoteCommandParts, parseArgs } from "./cli";

describe("parseArgs", () => {
  test("allows dry-run without a task", () => {
    expect(parseArgs(["my-org/my-repo", "--dry-run"])).toMatchObject({
      repo: "my-org/my-repo",
      task: "",
      dryRun: true,
    });
  });

  test("rejects unknown options", () => {
    expect(() => parseArgs(["my-org/my-repo", "ship it", "--wat"])).toThrow(
      "unknown option: --wat"
    );
  });

  test("rejects missing flag values", () => {
    expect(() => parseArgs(["my-org/my-repo", "ship it", "--model"])).toThrow(
      "--model requires a value"
    );
  });
});

describe("buildLocalChildArgs", () => {
  test("forwards dry-run and deep-review without injecting an empty task", () => {
    const parsed = parseArgs([
      "my-org/my-repo",
      "--dry-run",
      "--local",
      "--bg",
      "--deep-review",
      "--model",
      "sonnet",
    ]);

    expect(buildLocalChildArgs(parsed)).toEqual([
      "--local",
      "my-org/my-repo",
      "--model",
      "sonnet",
      "--dry-run",
      "--deep-review",
    ]);
  });
});

describe("buildRemoteCommandParts", () => {
  test("shell-escapes repo and task text", () => {
    const parsed = parseArgs(["my-org/my-repo", "fix it's broken", "--dry-run"]);

    expect(buildRemoteCommandParts(parsed)).toEqual([
      "~/.bun/bin/oneshot",
      "--local",
      "'my-org/my-repo'",
      "'fix it'\\''s broken'",
      "--dry-run",
    ]);
  });
});
