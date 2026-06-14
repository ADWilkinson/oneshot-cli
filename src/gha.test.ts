import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { GHA_WORKFLOW_PATH, initGhaWorkflow, renderWorkflow } from "./gha";

const tempDirs: string[] = [];
const makeTempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "oneshot-gha-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("renderWorkflow", () => {
  test("codex provider wires the OpenAI secret", () => {
    const yml = renderWorkflow({ provider: "codex" });
    expect(yml).toContain("workflow_dispatch");
    expect(yml).toContain("bun install -g oneshot-ship");
    expect(yml).toContain("OPENAI_API_KEY");
    expect(yml).toContain("@openai/codex");
    expect(yml).not.toContain("ANTHROPIC_API_KEY");
  });

  test("claude provider wires the Anthropic secret", () => {
    const yml = renderWorkflow({ provider: "claude" });
    expect(yml).toContain("ANTHROPIC_API_KEY");
    expect(yml).toContain("@anthropic-ai/claude-code");
  });

  test("checks out into owner/repo layout matching resolveRepoPath", () => {
    const yml = renderWorkflow();
    expect(yml).toContain("path: workspace/${{ github.repository }}");
    expect(yml).toContain('--base-path "$GITHUB_WORKSPACE/workspace"');
  });

  test("uploads the receipt as an artifact", () => {
    const yml = renderWorkflow();
    expect(yml).toContain("upload-artifact");
    expect(yml).toContain("oneshot receipt");
    expect(yml).toContain("oneshot-receipt.html");
  });
});

describe("initGhaWorkflow", () => {
  test("creates the workflow file once", () => {
    const dir = makeTempDir();
    const first = initGhaWorkflow(dir);
    expect(first.created).toBe(true);
    expect(first.path).toBe(join(dir, GHA_WORKFLOW_PATH));
    expect(first.secretName).toBe("OPENAI_API_KEY");
    expect(readFileSync(first.path, "utf-8")).toContain("name: oneshot");

    const second = initGhaWorkflow(dir);
    expect(second.created).toBe(false);
  });

  test("reports the right secret for the claude provider", () => {
    const dir = makeTempDir();
    const result = initGhaWorkflow(dir, { provider: "claude" });
    expect(result.secretName).toBe("ANTHROPIC_API_KEY");
  });
});
