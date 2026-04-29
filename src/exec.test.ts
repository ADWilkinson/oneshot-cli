import { describe, expect, test } from "bun:test";
import { exec } from "./exec";

describe("killProcessTree", () => {
  test.skipIf(process.platform !== "linux")("kills a timed-out grandchild process", async () => {
    await expect(
      exec('bash -c "sleep 30"', { timeoutMs: 2_000 })
    ).rejects.toMatchObject({ code: "ERR_TIMEOUT" });

    await new Promise((resolve) => setTimeout(resolve, 6_000));

    const proc = Bun.spawn(["pgrep", "-f", "^sleep 30$"], {
      stdout: "ignore",
      stderr: "ignore",
    });

    expect(await proc.exited).toBe(1);
  }, 15_000);
});
