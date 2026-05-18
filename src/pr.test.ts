import { describe, expect, test } from "bun:test";
import { getPrModel } from "./steps/pr";
import type { PipelineContext } from "./config";

const makeContext = (modelOverride?: string): PipelineContext =>
  ({
    config: {
      host: "example-host",
      basePath: "~/projects",
      provider: "codex",
      claude: { model: "opus-from-config", timeoutMinutes: 180 },
      codex: { model: "gpt-5.5", reasoningEffort: "xhigh", timeoutMinutes: 180 },
    },
    options: {
      repo: "demo/repo",
      task: "fix bug",
      model: modelOverride,
    },
    runId: "test-run",
    repoPath: "/tmp/repo",
    worktreePath: "/tmp/worktree",
    plan: "",
    prUrl: "",
    startTime: 0,
    mode: "fast",
  }) as PipelineContext;

describe("getPrModel", () => {
  test("uses the configured provider model when no override is provided", () => {
    expect(getPrModel(makeContext())).toBe("gpt-5.5");
  });

  test("prefers the explicit model override when present", () => {
    expect(getPrModel(makeContext("sonnet"))).toBe("sonnet");
  });
});
