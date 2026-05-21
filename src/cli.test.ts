import { afterEach, describe, expect, test } from "bun:test";
import {
  buildLocalChildArgs,
  buildRemoteBackgroundShellCommand,
  buildRemoteCommandParts,
  buildRemotePassthroughShellCommand,
  buildRemoteStatsShellCommand,
  buildRemoteShellCommand,
  parseArgs,
} from "./cli";
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
  const proc = Bun.spawn([process.execPath, "run", "src/cli.ts", ...args], {
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

const runCommand = async (
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {}
): Promise<string> => {
  const proc = Bun.spawn(args, {
    cwd: options.cwd ?? process.cwd(),
    env: { ...process.env, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  const stdout = await stdoutPromise;
  const stderr = await stderrPromise;
  if ((exitCode ?? 1) !== 0) {
    throw new Error(`${args.join(" ")} failed: ${stderr || stdout}`);
  }
  return stdout;
};

const git = (cwd: string, args: string[]): Promise<string> =>
  runCommand(["git", ...args], { cwd });

const writeFakeAgents = (binDir: string): void => {
  mkdirSync(binDir, { recursive: true });
  const codexPath = join(binDir, "codex");
  writeFileSync(
    codexPath,
    `#!/bin/sh
args="$*"
if printf '%s' "$args" | grep -q "senior software engineer planning"; then
  printf '%s\\n' "Plan the fixture update."
elif printf '%s' "$args" | grep -q "implementing code changes"; then
  printf '%s\\n' "execute change" >> oneshot-fixture.txt
  git add oneshot-fixture.txt
  git -c user.email=oneshot@local -c user.name=oneshot commit -m "fix: update fixture" >/dev/null
  if [ -n "$SOURCE_REPO_TO_MUTATE" ]; then
    git -C "$SOURCE_REPO_TO_MUTATE" checkout side >/dev/null 2>&1
  fi
  printf '%s\\n' '{"type":"turn.completed"}'
elif printf '%s' "$args" | grep -q "reviewing code changes"; then
  printf '%s\\n' "review change" >> oneshot-fixture.txt
  printf '%s\\n' '{"type":"turn.completed"}'
elif printf '%s' "$args" | grep -q "finalizing a commit"; then
  if ! git diff --quiet || [ -n "$(git ls-files --others --exclude-standard)" ]; then
    git add -A
    git -c user.email=oneshot@local -c user.name=oneshot commit -m "fix: update fixture" >/dev/null
  fi
  printf 'fix: update fixture' > .oneshot-pr-title.txt
  cat > .oneshot-pr-body.txt <<'BODY'
## Summary
- Updates the fixture file.

## Why
This verifies the oneshot temp-worktree flow.

## Changes
- Fixture file changed by the fake agent.

## Test plan
- bun test src/cli.test.ts
BODY
else
  printf '%s\\n' '{"type":"turn.completed"}'
fi
`
  );
  chmodSync(codexPath, 0o755);

  const ghPath = join(binDir, "gh");
  writeFileSync(
    ghPath,
    `#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  printf '%s\\n' "https://github.com/demo/repo/pull/1"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "edit" ]; then
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "ready" ]; then
  exit 0
fi
exit 1
`
  );
  chmodSync(ghPath, 0o755);
};

const createFixtureRepo = async (): Promise<{
  tempDir: string;
  home: string;
  basePath: string;
  repoPath: string;
  originPath: string;
  worktreeRoot: string;
  binDir: string;
}> => {
  const tempDir = makeTempDir();
  const home = join(tempDir, "home");
  const basePath = join(tempDir, "projects");
  const repoPath = join(basePath, "demo", "repo");
  const originPath = join(tempDir, "origin.git");
  const worktreeRoot = join(tempDir, "worktrees");
  const binDir = join(tempDir, "bin");

  mkdirSync(basePath, { recursive: true });
  mkdirSync(join(basePath, "demo"), { recursive: true });
  await git(tempDir, ["init", "--bare", originPath]);
  await git(basePath, ["clone", originPath, repoPath]);
  await git(repoPath, ["config", "user.email", "test@example.com"]);
  await git(repoPath, ["config", "user.name", "Test User"]);
  writeFileSync(join(repoPath, "oneshot-fixture.txt"), "base\n");
  await git(repoPath, ["add", "oneshot-fixture.txt"]);
  await git(repoPath, ["commit", "-m", "initial commit"]);
  await git(repoPath, ["branch", "-M", "main"]);
  await git(repoPath, ["push", "-u", "origin", "main"]);
  writeFakeAgents(binDir);

  return { tempDir, home, basePath, repoPath, originPath, worktreeRoot, binDir };
};

const currentBranch = (repoPath: string): Promise<string> =>
  git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]).then((value) => value.trim());

const currentHead = (repoPath: string): Promise<string> =>
  git(repoPath, ["rev-parse", "HEAD"]).then((value) => value.trim());

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

  test("rejects unsupported init arguments", () => {
    expect(() => parseArgs(["init", "--local"])).toThrow(
      "init does not accept arguments: --local"
    );
  });

  test("rejects unsupported stats options", () => {
    expect(() => parseArgs(["stats", "--bg"])).toThrow(
      "stats only accepts --local; unknown option: --bg"
    );
  });

  test("parses doctor command with json output", () => {
    expect(parseArgs(["doctor", "--local", "--json", "--repo", "zkp2p/pay"])).toMatchObject({
      command: "doctor",
      local: true,
      json: true,
      doctorRepo: "zkp2p/pay",
    });
  });

  test("parses route command with json output", () => {
    expect(parseArgs(["route", "fix failing CI", "--json", "--provider", "claude"])).toMatchObject({
      command: "route",
      task: "fix failing CI",
      json: true,
      routeProvider: "claude",
    });
  });

  test("parses durable run commands", () => {
    expect(parseArgs(["runs", "--local", "--json", "--limit", "5"])).toMatchObject({
      command: "runs",
      local: true,
      json: true,
      limit: 5,
    });
    expect(parseArgs(["status", "run-123", "--json"])).toMatchObject({
      command: "status",
      runRef: "run-123",
      json: true,
    });
    expect(parseArgs(["eval", "--limit", "7"])).toMatchObject({
      command: "eval",
      limit: 7,
    });
  });

  test("parses workflow and policy commands", () => {
    expect(parseArgs(["workflow", "show", "ship", "--json"])).toMatchObject({
      command: "workflow",
      workflowCommand: "show",
      workflowName: "ship",
      json: true,
    });
    expect(parseArgs(["policy", "init", "--path", "/tmp/repo"])).toMatchObject({
      command: "policy",
      policyAction: "init",
      policyPath: "/tmp/repo",
    });
  });

  test("parses workflow flag for run dispatch", () => {
    expect(parseArgs(["my-org/my-repo", "fix bug", "--workflow", "ship"])).toMatchObject({
      repo: "my-org/my-repo",
      task: "fix bug",
      workflow: "ship",
    });
  });

  test("rejects unsupported doctor options", () => {
    expect(() => parseArgs(["doctor", "--bg"])).toThrow(
      "doctor only accepts --local, --json, and --repo; unknown option: --bg"
    );
  });

  test("rejects unsupported route options", () => {
    expect(() => parseArgs(["route", "ship it", "--bg"])).toThrow(
      "route only accepts --json, --provider, and --mode; unknown option: --bg"
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
      "--worktree-root",
      "/var/tmp/oneshot",
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
      "--worktree-root",
      "/var/tmp/oneshot",
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
      "--worktree-root",
      "/var/tmp/oneshot",
      "--mode",
      "fast",
      "--dry-run",
    ]);

    expect(buildRemoteCommandParts(parsed)).toEqual([
      "--local",
      "'my-org/my-repo'",
      "'fix it'\\''s broken'",
      "--base-path",
      "'/srv/work dir'",
      "--worktree-root",
      "'/var/tmp/oneshot'",
      "--mode",
      "'fast'",
      "--dry-run",
    ]);
  });
});

describe("remote shell wrappers", () => {
  test("foreground wrapper streams config into a temp file and cleans it up", () => {
    const command = buildRemoteShellCommand([
      "--local",
      "'demo/repo'",
      "'fix bug'",
    ]);

    expect(command).toContain('tmp_config=$(mktemp /tmp/oneshot-config.XXXXXX.json) || exit 1');
    expect(command).toContain('cat > "$tmp_config"');
    expect(command).toContain('command -v oneshot');
    expect(command).toContain('ONESHOT_CONFIG_PATH="$0" "$oneshot_bin" "$@"; status=$?; rm -f "$0"; exit $status');
    expect(command).toContain("--local 'demo/repo' 'fix bug'");
  });

  test("read-only passthrough wrapper executes remote local commands", () => {
    const command = buildRemotePassthroughShellCommand(["runs", "--json"]);
    expect(command).toContain('exec "$oneshot_bin"');
    expect(command).toContain("'runs' '--json' --local");
  });

  test("background wrapper keeps the temp config alive for the detached run", () => {
    const command = buildRemoteBackgroundShellCommand([
      "--local",
      "'demo/repo'",
      "'fix bug'",
    ], "/tmp/oneshot.log");

    expect(command).toContain('nohup sh -c');
    expect(command).toContain('cat > "$tmp_config"');
    expect(command).toContain('> \'/tmp/oneshot.log\' 2>&1 &');
    expect(command).toContain('echo "PID: $!"');
    expect(command).toContain('echo "LOG: /tmp/oneshot.log"');
    // Regression: bash rejects "&;" and "& ;". The background line ends in "&", so
    // the wrapper must separate statements with a newline, not "; ".
    expect(command).not.toMatch(/&\s*;/);
  });

  test("stats wrapper resolves oneshot from the environment before falling back", () => {
    const command = buildRemoteStatsShellCommand();

    expect(command).toContain('command -v oneshot');
    expect(command).toContain('BUN_INSTALL');
    expect(command).toContain('exec "$oneshot_bin" stats --local');
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
        codex: { model: "gpt-5.5", reasoningEffort: "xhigh", timeoutMinutes: 180 },
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
    const sshStdinFile = join(tempDir, "ssh-stdin.json");
    mkdirSync(oneshotDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });

    writeFileSync(
      join(oneshotDir, "config.json"),
      JSON.stringify({
        host: "example-host",
        basePath: "/srv/agent-workspace",
        anthropicApiKey: "ant-test",
        linearApiKey: "lin-test",
        claude: { model: "opus", timeoutMinutes: 180 },
        codex: { model: "gpt-5.5", reasoningEffort: "xhigh", timeoutMinutes: 180 },
      })
    );

    const sshPath = join(binDir, "ssh");
    writeFileSync(
      sshPath,
      "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$SSH_ARGS_FILE\"\ncat > \"$SSH_STDIN_FILE\"\nexit 0\n"
    );
    chmodSync(sshPath, 0o755);

    const result = await runCli(["demo/repo", "dry run task", "--dry-run"], {
      HOME: home,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      SSH_ARGS_FILE: sshArgsFile,
      SSH_STDIN_FILE: sshStdinFile,
    });

    expect(result.exitCode).toBe(0);

    const sshArgs = readFileSync(sshArgsFile, "utf-8");
    expect(sshArgs).toContain("example-host");
    expect(sshArgs).toContain('tmp_config=$(mktemp /tmp/oneshot-config.XXXXXX.json) || exit 1');
    expect(sshArgs).toContain("--base-path '/srv/agent-workspace'");
    expect(sshArgs).toContain("'demo/repo' 'dry run task'");

    const forwardedConfig = JSON.parse(readFileSync(sshStdinFile, "utf-8"));
    expect(forwardedConfig.basePath).toBe("/srv/agent-workspace");
    expect(forwardedConfig.anthropicApiKey).toBe("ant-test");
    expect(forwardedConfig.linearApiKey).toBe("lin-test");
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

  test("local pipeline preserves the source checkout branch and pushes the PR branch", async () => {
    const fixture = await createFixtureRepo();
    const beforeBranch = await currentBranch(fixture.repoPath);
    const beforeHead = await currentHead(fixture.repoPath);

    const result = await runCli([
      "demo/repo",
      `update fixture without touching ${fixture.repoPath}`,
      "--local",
      "--base-path",
      fixture.basePath,
      "--worktree-root",
      fixture.worktreeRoot,
      "--mode",
      "fast",
    ], {
      HOME: fixture.home,
      PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
    });

    expect(result.exitCode).toBe(0);
    expect(stripAnsi(result.stdout)).toContain("PR: https://github.com/demo/repo/pull/1");
    expect(await currentBranch(fixture.repoPath)).toBe(beforeBranch);
    expect(await currentHead(fixture.repoPath)).toBe(beforeHead);

    const branches = await runCommand([
      "git",
      "--git-dir",
      fixture.originPath,
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads/oneshot",
    ]);
    const prBranch = branches.trim().split("\n").find(Boolean);
    if (!prBranch) throw new Error("missing pushed PR branch");
    expect(prBranch).toMatch(/^oneshot\/update-fixture/);

    const contents = await runCommand([
      "git",
      "--git-dir",
      fixture.originPath,
      "show",
      `${prBranch}:oneshot-fixture.txt`,
    ]);
    expect(contents).toContain("execute change");
    expect(contents).toContain("review change");
  });

  test("local pipeline fails loudly if the source checkout branch changes", async () => {
    const fixture = await createFixtureRepo();
    await git(fixture.repoPath, ["checkout", "-b", "side"]);
    await git(fixture.repoPath, ["checkout", "main"]);
    const beforeHead = await currentHead(fixture.repoPath);

    const result = await runCli([
      "demo/repo",
      `mutate source checkout ${fixture.repoPath}`,
      "--local",
      "--base-path",
      fixture.basePath,
      "--worktree-root",
      fixture.worktreeRoot,
      "--mode",
      "fast",
    ], {
      HOME: fixture.home,
      PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
      SOURCE_REPO_TO_MUTATE: fixture.repoPath,
    });

    const output = stripAnsi(`${result.stdout}\n${result.stderr}`);
    expect(result.exitCode).toBe(1);
    expect(output).toContain(`source checkout mutated at ${fixture.repoPath}`);
    expect(output).toContain(`before main@${beforeHead}`);
    expect(output).toContain(`after side@${beforeHead}`);
    expect(await currentBranch(fixture.repoPath)).toBe("side");
  });

  test("doctor local json reports tool and config state", async () => {
    const tempDir = makeTempDir();
    const home = join(tempDir, "home");
    const binDir = join(tempDir, "bin");
    mkdirSync(binDir, { recursive: true });

    for (const name of ["bun", "git", "gh", "claude", "codex", "npm"]) {
      const bin = join(binDir, name);
      const output = name === "npm" ? "0.2.9" : `${name} test`;
      writeFileSync(bin, `#!/bin/sh\necho '${output}'\n`);
      chmodSync(bin, 0o755);
    }

    const result = await runCli(["doctor", "--local", "--json"], {
      HOME: home,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });

    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.target).toBe("local");
    expect(report.latestVersion).toBe("0.2.9");
    expect(report.checks.some((item: { name: string; status: string }) => item.name === "config" && item.status === "warn")).toBe(true);
    expect(report.checks.some((item: { name: string; status: string }) => item.name === "codex" && item.status === "ok")).toBe(true);
  });

  test("doctor local can verify a configured repo checkout", async () => {
    const tempDir = makeTempDir();
    const home = join(tempDir, "home");
    const repoPath = join(home, "projects", "demo", "repo", ".git");
    const binDir = join(tempDir, "bin");
    mkdirSync(repoPath, { recursive: true });
    mkdirSync(binDir, { recursive: true });

    for (const name of ["bun", "git", "gh", "claude", "codex", "npm"]) {
      const bin = join(binDir, name);
      const output = name === "npm" ? "0.2.9" : `${name} test`;
      writeFileSync(bin, `#!/bin/sh\necho '${output}'\n`);
      chmodSync(bin, 0o755);
    }

    const result = await runCli(["doctor", "--local", "--json", "--repo", "demo/repo"], {
      HOME: home,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    });

    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.repo).toBe("demo/repo");
    expect(report.checks.some((item: { name: string; status: string }) => item.name === "repo" && item.status === "ok")).toBe(true);
  });
});
