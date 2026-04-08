import { afterEach, describe, expect, test } from "bun:test";
import { buildLocalChildArgs, buildRemoteCommandParts, parseArgs } from "./cli";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const cleanupPaths = new Set<string>();

afterEach(() => {
  for (const filePath of cleanupPaths) {
    try {
      rmSync(filePath, { recursive: true, force: true });
    } catch {
      // best effort cleanup
    }
  }
  cleanupPaths.clear();
});

const makeTempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "oneshot-cli-test-"));
  cleanupPaths.add(dir);
  return dir;
};

const stripAnsi = (value: string): string => value.replace(/\x1b\[[0-9;]*m/g, "");

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const runCli = async (
  args: string[],
  env: Record<string, string>
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const proc = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return {
    exitCode,
    stdout: await stdoutPromise,
    stderr: await stderrPromise,
  };
};

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

  test("rejects invalid mode overrides", () => {
    expect(() => parseArgs(["my-org/my-repo", "ship it", "--mode", "turbo"])).toThrow(
      '--mode must be "fast" or "deep"'
    );
  });
});

describe("buildLocalChildArgs", () => {
  test("forwards mode, dry-run, and deep-review without injecting an empty task", () => {
    const parsed = parseArgs([
      "my-org/my-repo",
      "--dry-run",
      "--local",
      "--bg",
      "--base-path",
      "/srv/workspace",
      "--mode",
      "deep",
      "--deep-review",
      "--model",
      "sonnet",
    ]);

    expect(buildLocalChildArgs(parsed)).toEqual([
      "--local",
      "my-org/my-repo",
      "--model",
      "sonnet",
      "--base-path",
      "/srv/workspace",
      "--mode",
      "deep",
      "--dry-run",
      "--deep-review",
    ]);
  });
});

describe("buildRemoteCommandParts", () => {
  test("shell-escapes repo and task text", () => {
    const parsed = parseArgs([
      "my-org/my-repo",
      "fix it's broken",
      "--base-path",
      "/srv/work dir",
      "--mode",
      "fast",
      "--dry-run",
    ]);

    expect(buildRemoteCommandParts(parsed)).toEqual([
      "~/.bun/bin/oneshot",
      "--local",
      "'my-org/my-repo'",
      "'fix it'\\''s broken'",
      "--base-path",
      "'/srv/work dir'",
      "--mode",
      "'fast'",
      "--dry-run",
    ]);
  });
});

describe("CLI integration", () => {
  test("local dry-run works without an existing config file", async () => {
    const tempDir = makeTempDir();
    const home = join(tempDir, "home");
    const repoPath = join(home, "projects", "demo", "repo", ".git");
    const binDir = join(tempDir, "bin");
    mkdirSync(repoPath, { recursive: true });
    mkdirSync(binDir, { recursive: true });

    const gitPath = join(binDir, "git");
    writeFileSync(gitPath, "#!/bin/sh\nexit 0\n");
    chmodSync(gitPath, 0o755);

    const result = await runCli(["demo/repo", "--dry-run", "--local"], {
      HOME: home,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });

    expect(result.exitCode).toBe(0);
    expect(stripAnsi(result.stdout)).toContain("Dry run complete");
    expect(stripAnsi(result.stderr)).not.toContain("no config found");
  });

  test("remote background mode exits non-zero when ssh launch fails", async () => {
    const tempDir = makeTempDir();
    const home = join(tempDir, "home");
    const oneshotDir = join(home, ".oneshot");
    const binDir = join(tempDir, "bin");
    mkdirSync(oneshotDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });

    writeFileSync(
      join(oneshotDir, "config.json"),
      JSON.stringify({
        host: "example-host",
        basePath: "~/projects",
        claude: { model: "opus", timeoutMinutes: 180 },
        codex: { model: "gpt-5.4-mini", reasoningEffort: "xhigh", timeoutMinutes: 180 },
      })
    );

    const sshPath = join(binDir, "ssh");
    writeFileSync(sshPath, "#!/bin/sh\necho 'fake ssh failure' >&2\nexit 255\n");
    chmodSync(sshPath, 0o755);

    const result = await runCli(["demo/repo", "test task", "--bg"], {
      HOME: home,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });

    expect(result.exitCode).toBe(255);
    expect(stripAnsi(result.stdout)).not.toContain("shipped to background on server");
    expect(stripAnsi(result.stderr)).toContain("fake ssh failure");
  });

  test("remote runs forward the configured basePath over ssh", async () => {
    const tempDir = makeTempDir();
    const home = join(tempDir, "home");
    const oneshotDir = join(home, ".oneshot");
    const binDir = join(tempDir, "bin");
    const sshArgsFile = join(tempDir, "ssh-args.txt");
    mkdirSync(oneshotDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });

    writeFileSync(
      join(oneshotDir, "config.json"),
      JSON.stringify({
        host: "example-host",
        basePath: "/srv/agent-workspace",
        claude: { model: "opus", timeoutMinutes: 180 },
        codex: { model: "gpt-5.4-mini", reasoningEffort: "xhigh", timeoutMinutes: 180 },
      })
    );

    const sshPath = join(binDir, "ssh");
    writeFileSync(
      sshPath,
      "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$SSH_ARGS_FILE\"\nexit 0\n"
    );
    chmodSync(sshPath, 0o755);

    const result = await runCli(["demo/repo", "dry run task", "--dry-run"], {
      HOME: home,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      SSH_ARGS_FILE: sshArgsFile,
    });

    expect(result.exitCode).toBe(0);

    const sshArgs = readFileSync(sshArgsFile, "utf-8");
    expect(sshArgs).toContain("example-host");
    expect(sshArgs).toContain("--base-path '/srv/agent-workspace'");
    expect(sshArgs).toContain("'demo/repo' 'dry run task'");
  });

  test("stats renders dry-runs distinctly instead of unknown", async () => {
    const tempDir = makeTempDir();
    const home = join(tempDir, "home");
    const oneshotDir = join(home, ".oneshot");
    const runId = `dry-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const repo = `dry-run-${Date.now()}/repo`;
    const eventFile = `/tmp/oneshot-${runId}.events.jsonl`;
    cleanupPaths.add(eventFile);

    mkdirSync(oneshotDir, { recursive: true });
    writeFileSync(join(oneshotDir, "history.json"), JSON.stringify({ [repo]: [60_000] }));
    writeFileSync(
      eventFile,
      [
        JSON.stringify({ type: "started", runId, repo, task: "dry run", timestamp: Date.now() - 1_000 }),
        JSON.stringify({ type: "completed", runId, result: "dry-run", elapsed: 1_234, timestamp: Date.now() }),
      ].join("\n") + "\n"
    );

    const result = await runCli(["stats", "--local"], {
      HOME: home,
      PATH: process.env.PATH ?? "",
    });

    const output = stripAnsi(result.stdout);
    expect(result.exitCode).toBe(0);
    expect(output).toMatch(new RegExp(`${escapeRegExp(repo)}.*dry run complete`));
    expect(output).not.toMatch(new RegExp(`${escapeRegExp(repo)}.*unknown`));
  });
});
