import { describe, expect, test } from "bun:test";
import { exec as runShell, OneshotError } from "./exec";

const pgrepCount = async (pattern: string): Promise<number> => {
  const proc = Bun.spawn(["pgrep", "-f", pattern], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.split("\n").filter(Boolean).length;
};

describe("exec timeout", () => {
  // pgrep + signal semantics match on darwin/linux; skip only on Windows.
  test.skipIf(process.platform === "win32")(
    "kills the grandchild process tree, not just the bash wrapper",
    async () => {
      // Unique duration tags the orphaned `sleep` so pgrep can find it. The
      // trailing `; true` keeps bash from exec-replacing itself, forcing a real
      // bash -> sleep tree whose child only dies if the whole group is signaled.
      const dur = (90 + Math.random()).toFixed(5);
      const marker = `sleep ${dur}`;

      await expect(runShell(`${marker}; true`, { timeoutMs: 300 })).rejects.toBeInstanceOf(OneshotError);

      // Past the 5s SIGTERM -> SIGKILL escalation window.
      await new Promise((resolve) => setTimeout(resolve, 6500));
      expect(await pgrepCount(marker)).toBe(0);
    },
    15_000,
  );
});
