import { describe, expect, test } from "bun:test";
import { translateCodexJsonLine } from "./codex-events";
import { buildCodexExecCommand } from "./codex-runner";

describe("translateCodexJsonLine", () => {
  test("translates command execution lifecycle events", () => {
    const started = translateCodexJsonLine(JSON.stringify({
      type: "item.started",
      item: {
        type: "command_execution",
        id: "cmd-1",
        command: "bun test",
        aggregated_output: "",
        exit_code: null,
        status: "in_progress",
      },
    }));

    expect(started).toEqual([
      {
        phase: "started",
        kind: "command",
        title: "bun test",
        detail: {
          id: "cmd-1",
          status: "in_progress",
          exitCode: undefined,
          command: "bun test",
        },
        ok: undefined,
      },
    ]);

    const completed = translateCodexJsonLine(JSON.stringify({
      type: "item.completed",
      item: {
        type: "command_execution",
        id: "cmd-1",
        command: "bun test",
        aggregated_output: "ok",
        exit_code: 0,
        status: "completed",
      },
    }));

    expect(completed[0]).toMatchObject({
      phase: "completed",
      kind: "command",
      title: "bun test",
      ok: true,
      detail: { exitCode: 0, status: "completed" },
    });
  });

  test("summarizes todo and file change events", () => {
    const todo = translateCodexJsonLine(JSON.stringify({
      type: "item.updated",
      item: {
        type: "todo_list",
        id: "todo-1",
        items: [
          { text: "inspect repo", completed: true },
          { text: "run tests", completed: false },
        ],
      },
    }));

    expect(todo[0]).toMatchObject({
      phase: "updated",
      kind: "todo",
      title: "todo 1/2: run tests",
      detail: { done: 1, total: 2 },
    });

    const fileChange = translateCodexJsonLine(JSON.stringify({
      type: "item.completed",
      item: {
        type: "file_change",
        id: "patch-1",
        status: "completed",
        changes: [
          { path: "src/a.ts", kind: "update" },
          { path: "src/b.ts", kind: "add" },
        ],
      },
    }));

    expect(fileChange[0]).toMatchObject({
      phase: "completed",
      kind: "file_change",
      title: "src/a.ts, src/b.ts",
      ok: true,
      detail: {
        changes: [
          { path: "src/a.ts", kind: "update" },
          { path: "src/b.ts", kind: "add" },
        ],
        status: "completed",
      },
    });
  });

  test("ignores malformed or irrelevant lines", () => {
    expect(translateCodexJsonLine("not json")).toEqual([]);
    expect(translateCodexJsonLine(JSON.stringify({ type: "unknown" }))).toEqual([]);
  });
});

describe("buildCodexExecCommand", () => {
  test("runs inside the worktree and enables JSONL events", () => {
    const command = buildCodexExecCommand({
      worktreePath: "/tmp/work tree",
      prompt: "fix it's broken",
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
    });

    expect(command).toContain("cd '/tmp/work tree' && codex exec");
    expect(command).toContain("--json");
    expect(command).toContain("--color=never");
    expect(command).toContain("--skip-git-repo-check");
    expect(command).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(command).toContain("-m 'gpt-5.5'");
    expect(command).toContain("-c 'model_reasoning_effort=\"xhigh\"'");
    expect(command).toContain("'fix it'\\''s broken'");
  });

  test("can build text-output commands for non-event phases", () => {
    const command = buildCodexExecCommand({
      worktreePath: "/tmp/work tree",
      prompt: "write a plan",
      model: "gpt-5.5",
      reasoningEffort: "high",
      json: false,
    });

    expect(command).not.toContain("--json");
    expect(command).toContain("codex exec");
    expect(command).toContain("-c 'model_reasoning_effort=\"high\"'");
  });
});
