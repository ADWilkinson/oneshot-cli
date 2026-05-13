import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { normalizeConfig } from "./config";

describe("normalizeConfig", () => {
  test("defaults review model and effort to the configured execution values", () => {
    const config = normalizeConfig(
      {
        host: "example-host",
        codex: {
          model: "gpt-custom",
          reasoningEffort: "high",
          timeoutMinutes: 90,
        },
      },
      { requireHost: true },
    );

    expect(config.codex.model).toBe("gpt-custom");
    expect(config.codex.reasoningEffort).toBe("high");
    expect(config.codex.reviewModel).toBe("gpt-custom");
    expect(config.codex.reviewReasoningEffort).toBe("high");
  });

  test("explicit review model and effort still win", () => {
    const config = normalizeConfig(
      {
        host: "example-host",
        codex: {
          model: "gpt-execute",
          reasoningEffort: "medium",
          reviewModel: "gpt-review",
          reviewReasoningEffort: "xhigh",
          timeoutMinutes: 90,
        },
      },
      { requireHost: true },
    );

    expect(config.codex.reviewModel).toBe("gpt-review");
    expect(config.codex.reviewReasoningEffort).toBe("xhigh");
  });
});

describe("saveConfig", () => {
  test("creates the parent directory for a custom ONESHOT_CONFIG_PATH", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "oneshot-config-test-"));
    const configPath = join(tempDir, "nested", "config.json");
    const script = `
      import { saveConfig } from "./src/config.ts";
      saveConfig({
        host: "example-host",
        basePath: "~/projects",
        claude: { model: "opus", timeoutMinutes: 180 },
        codex: { model: "gpt-5.5", reasoningEffort: "xhigh", timeoutMinutes: 180 }
      });
    `;

    try {
      const proc = Bun.spawn(["bun", "--eval", script], {
        cwd: process.cwd(),
        env: { ...process.env, ONESHOT_CONFIG_PATH: configPath },
        stdout: "pipe",
        stderr: "pipe",
      });
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(existsSync(configPath)).toBe(true);
      expect(JSON.parse(readFileSync(configPath, "utf8")).host).toBe("example-host");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
