import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { EventWriter, getDefaultEventsFile } from "./events";

const cleanupPaths = new Set<string>();

afterEach(() => {
  for (const filePath of cleanupPaths) {
    try {
      rmSync(filePath, { force: true });
    } catch {
      // best effort cleanup
    }
  }
  cleanupPaths.clear();
});

describe("EventWriter", () => {
  test("writes to the default stats file and the requested custom file", () => {
    const runId = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const defaultFile = getDefaultEventsFile(runId);
    const customFile = join(tmpdir(), `oneshot-custom-${runId}.jsonl`);
    cleanupPaths.add(defaultFile);
    cleanupPaths.add(customFile);

    const writer = new EventWriter(customFile, runId);
    writer.started("my-org/my-repo", "ship it");
    writer.agentAction(5, "Executing with Codex", {
      phase: "completed",
      kind: "command",
      title: "bun test",
      ok: true,
      detail: { exitCode: 0 },
    });
    writer.completed({ elapsed: 123 });

    expect(existsSync(defaultFile)).toBe(true);
    expect(existsSync(customFile)).toBe(true);

    const defaultEvents = readFileSync(defaultFile, "utf-8").trim().split("\n");
    const customEvents = readFileSync(customFile, "utf-8").trim().split("\n");

    expect(defaultEvents).toHaveLength(3);
    expect(customEvents).toEqual(defaultEvents);

    const agentEvent = JSON.parse(defaultEvents[1]);
    expect(agentEvent).toMatchObject({
      type: "agent",
      runId,
      step: 5,
      label: "Executing with Codex",
      source: "codex",
      phase: "completed",
      kind: "command",
      title: "bun test",
      ok: true,
      detail: { exitCode: 0 },
    });
  });
});
