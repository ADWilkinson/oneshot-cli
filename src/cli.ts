#!/usr/bin/env bun

import { loadConfig, loadLocalConfig, saveConfig, CONFIG_PATH } from "./config";
import type { OneshotConfig, OneshotOptions } from "./config";
import { runPipeline } from "./pipeline";
import { log } from "./log";
import { isLinearUrl, extractIssueId, fetchIssue, formatIssueAsTask } from "./linear";
import { runStats } from "./stats";
import { existsSync, openSync, closeSync } from "fs";
import { shellEscape } from "./shell";
import { VERSION } from "./version";
import type { ComplexityMode } from "./config";
import { buildDoctorReport, printDoctorReport } from "./doctor";

export interface ParsedArgs extends OneshotOptions {
  local: boolean;
  bg: boolean;
  command?: string;
  deepReview: boolean;
  json: boolean;
  doctorRepo?: string;
}

const parsePositiveInt = (value: string, fallback: number): number => {
  if (!/^\d+$/.test(value)) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const getFlagValue = (args: string[], index: number, flag: string): string => {
  const value = args[index + 1];
  if (value == null || value.startsWith("-")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
};

export const parseArgs = (args: string[]): ParsedArgs => {
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  if (args.includes("--version") || args.includes("-v")) {
    console.log(`oneshot v${VERSION}`);
    process.exit(0);
  }

  if (args[0] === "init") {
    if (args.length > 1) {
      throw new Error(`init does not accept arguments: ${args.slice(1).join(" ")}`);
    }
    return { command: "init", repo: "", task: "", local: false, bg: false, deepReview: false, json: false };
  }

  if (args[0] === "stats") {
    const invalid = args.slice(1).filter((arg) => arg !== "--local");
    if (invalid.length > 0) {
      throw new Error(`stats only accepts --local; unknown option: ${invalid[0]}`);
    }
    return { command: "stats", repo: "", task: "", local: args.includes("--local"), bg: false, deepReview: false, json: false };
  }

  if (args[0] === "doctor") {
    let local = false;
    let json = false;
    let doctorRepo: string | undefined;
    for (let i = 1; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--local") {
        local = true;
      } else if (arg === "--json") {
        json = true;
      } else if (arg === "--repo") {
        doctorRepo = getFlagValue(args, i, arg);
        i++;
      } else {
        throw new Error(`doctor only accepts --local, --json, and --repo; unknown option: ${arg}`);
      }
    }
    return { command: "doctor", repo: "", task: "", local, bg: false, deepReview: false, json, doctorRepo };
  }

  const positional: string[] = [];
  let model: string | undefined;
  let branch: string | undefined;
  let basePath: string | undefined;
  let mode: ComplexityMode | undefined;
  let eventsFile: string | undefined;
  let worktreeRoot: string | undefined;
  let dryRun = false;
  let deepReview = false;
  let local = false;
  let bg = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--model" || arg === "-m") {
      model = getFlagValue(args, i, arg);
      i++;
    } else if (arg === "--mode") {
      const value = getFlagValue(args, i, arg).toLowerCase();
      if (value !== "fast" && value !== "deep") {
        throw new Error(`--mode must be "fast" or "deep"`);
      }
      mode = value;
      i++;
    } else if (arg === "--dry-run" || arg === "-d") {
      dryRun = true;
    } else if (arg === "--deep-review") {
      deepReview = true;
    } else if (arg === "--local") {
      local = true;
    } else if (arg === "--branch" || arg === "-b") {
      branch = getFlagValue(args, i, arg);
      i++;
    } else if (arg === "--base-path") {
      basePath = getFlagValue(args, i, arg);
      i++;
    } else if (arg === "--events-file") {
      eventsFile = getFlagValue(args, i, arg);
      i++;
    } else if (arg === "--worktree-root") {
      worktreeRoot = getFlagValue(args, i, arg);
      i++;
    } else if (arg === "--bg") {
      bg = true;
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }

  if (positional.length < 1) { log.error("missing repo argument"); printUsage(); process.exit(1); }
  if (positional.length < 2 && !dryRun) { log.error("missing task description or Linear URL"); printUsage(); process.exit(1); }
  if (mode === "fast" && deepReview) {
    throw new Error("--mode fast is incompatible with --deep-review");
  }

  return {
    repo: positional[0],
    task: positional[1] ?? "",
    model,
    branch,
    basePath,
    worktreeRoot,
    mode,
    eventsFile,
    dryRun,
    deepReview,
    json: false,
    local,
    bg,
  };
};

export const buildRemoteCommandParts = (parsed: ParsedArgs): string[] => {
  const parts = ["--local", shellEscape(parsed.repo)];
  if (parsed.task) parts.push(shellEscape(parsed.task));
  if (parsed.model) parts.push("--model", shellEscape(parsed.model));
  if (parsed.branch) parts.push("--branch", shellEscape(parsed.branch));
  if (parsed.basePath) parts.push("--base-path", shellEscape(parsed.basePath));
  if (parsed.worktreeRoot) parts.push("--worktree-root", shellEscape(parsed.worktreeRoot));
  if (parsed.mode) parts.push("--mode", shellEscape(parsed.mode));
  if (parsed.eventsFile) parts.push("--events-file", shellEscape(parsed.eventsFile));
  if (parsed.dryRun) parts.push("--dry-run");
  if (parsed.deepReview) parts.push("--deep-review");
  return parts;
};

const REMOTE_ONESHOT_BIN_SETUP = [
  'oneshot_bin="${ONESHOT_BIN:-}"',
  'if [ -z "$oneshot_bin" ]; then oneshot_bin="$(command -v oneshot 2>/dev/null || true)"; fi',
  'if [ -z "$oneshot_bin" ] && [ -n "$BUN_INSTALL" ] && [ -x "$BUN_INSTALL/bin/oneshot" ]; then oneshot_bin="$BUN_INSTALL/bin/oneshot"; fi',
  'if [ -z "$oneshot_bin" ] && [ -x "$HOME/.bun/bin/oneshot" ]; then oneshot_bin="$HOME/.bun/bin/oneshot"; fi',
  'if [ -z "$oneshot_bin" ]; then echo "oneshot binary not found in ONESHOT_BIN, PATH, BUN_INSTALL, or $HOME/.bun/bin" >&2; exit 127; fi',
].join('; ');

const REMOTE_CONFIG_RUNNER = [
  REMOTE_ONESHOT_BIN_SETUP,
  'ONESHOT_CONFIG_PATH="$0" "$oneshot_bin" "$@"; status=$?; rm -f "$0"; exit $status',
].join('; ');

export const buildRemoteShellCommand = (parts: string[]): string => {
  return [
    'tmp_config=$(mktemp /tmp/oneshot-config.XXXXXX.json) || exit 1',
    'cat > "$tmp_config"',
    `sh -c ${shellEscape(REMOTE_CONFIG_RUNNER)} "$tmp_config" ${parts.join(" ")}`,
  ].join('; ');
};

export const buildRemoteBackgroundShellCommand = (parts: string[], logFile: string): string => {
  // Join with newlines, not "; ", because the nohup line ends in "&" and "&;" is a bash syntax error.
  return [
    'tmp_config=$(mktemp /tmp/oneshot-config.XXXXXX.json) || exit 1',
    'cat > "$tmp_config"',
    `nohup sh -c ${shellEscape(REMOTE_CONFIG_RUNNER)} "$tmp_config" ${parts.join(" ")} > ${shellEscape(logFile)} 2>&1 &`,
    'echo "PID: $!"',
    `echo "LOG: ${logFile}"`,
  ].join('\n');
};

export const buildRemoteStatsShellCommand = (): string => {
  return `${REMOTE_ONESHOT_BIN_SETUP}; exec "$oneshot_bin" stats --local`;
};

const writeRemoteConfig = (proc: Bun.Subprocess<"pipe", "inherit" | "pipe", "inherit" | "pipe">, config: OneshotConfig): void => {
  proc.stdin.write(JSON.stringify(config, null, 2) + "\n");
  proc.stdin.end();
};

export const buildLocalChildArgs = (parsed: ParsedArgs): string[] => {
  const args = ["--local", parsed.repo];
  if (parsed.task) args.push(parsed.task);
  if (parsed.model) args.push("--model", parsed.model);
  if (parsed.branch) args.push("--branch", parsed.branch);
  if (parsed.basePath) args.push("--base-path", parsed.basePath);
  if (parsed.worktreeRoot) args.push("--worktree-root", parsed.worktreeRoot);
  if (parsed.mode) args.push("--mode", parsed.mode);
  if (parsed.eventsFile) args.push("--events-file", parsed.eventsFile);
  if (parsed.dryRun) args.push("--dry-run");
  if (parsed.deepReview) args.push("--deep-review");
  return args;
};

const printUsage = () => {
  console.log(`
Usage: oneshot <repo> "<task or linear url>" [options]
       oneshot init
       oneshot stats
       oneshot doctor
       oneshot doctor --repo <owner/repo>

Commands:
  init                    Set up ~/.oneshot/config.json interactively
  stats                   Show recent runs, success rates, per-repo averages
  doctor                  Check local and remote oneshot prerequisites

Options:
  --model, -m <model>     Override Claude model (default: from config)
  --branch, -b <branch>   Base branch to work from and PR into (default: main)
  --base-path <path>      Override the workspace path used to locate the repo
  --worktree-root <path>  Override where temporary git worktrees are created
  --mode <fast|deep>      Skip classification and force the requested review mode
  --deep-review           Force deep review mode
  --local                 Run locally instead of over SSH
  --dry-run, -d           Validate repo exists without running pipeline
  --events-file <path>    Mirror JSONL events to an additional file
  --repo <owner/repo>     With doctor, verify a specific checkout exists
  --bg                    Run detached in background (returns PID + log path)
  --help, -h              Show this help
  --version, -v           Show version

Examples:
  oneshot init
  oneshot my-org/my-repo "fix the login bug"
  oneshot my-org/my-repo https://linear.app/team/issue/ABC-123/slug
  oneshot my-org/my-repo "add dark mode" --bg
  oneshot my-org/my-repo "fix staging bug" --branch staging
  oneshot my-org/my-repo --dry-run
  oneshot stats
  oneshot doctor
  oneshot doctor --repo my-org/my-repo
`);
};

const prompt = async (question: string, defaultValue?: string): Promise<string> => {
  const suffix = defaultValue ? ` (${defaultValue})` : "";
  process.stdout.write(`${question}${suffix}: `);
  for await (const line of console) {
    const value = line.trim();
    return value || defaultValue || "";
  }
  return defaultValue || "";
};

const runInit = async () => {
  console.log("\noneshot init\n");

  if (existsSync(CONFIG_PATH)) {
    const overwrite = await prompt("config already exists. overwrite? (y/N)");
    if (overwrite.toLowerCase() !== "y") {
      console.log("aborted");
      process.exit(0);
    }
  }

  console.log("configure your remote server (SSH target where Claude + Codex run):\n");

  const host = await prompt("  ssh host (e.g. user@100.x.x.x)");
  if (!host) { log.error("host is required"); process.exit(1); }

  const basePath = await prompt("  workspace path on server", "~/projects");
  const worktreeRoot = await prompt("  worktree scratch path", "/tmp");

  console.log("\napi keys (stored in ~/.oneshot/config.json):\n");

  const anthropicApiKey = await prompt("  anthropic api key (optional, or set ANTHROPIC_API_KEY on server)");
  const linearApiKey = await prompt("  linear api key (optional, for ticket integration)");

  console.log("\nmodel defaults:\n");

  const claudeModel = await prompt("  claude model (for planning + PR)", "opus");
  const claudeTimeout = await prompt("  claude timeout in minutes", "180");
  const codexModel = await prompt("  codex model (for execution + review)", "gpt-5.5");
  const codexEffort = await prompt("  codex reasoning effort", "xhigh");
  const codexTimeout = await prompt("  codex timeout in minutes", "180");

  const config: OneshotConfig = {
    host,
    basePath,
    worktreeRoot,
    claude: {
      model: claudeModel,
      timeoutMinutes: parsePositiveInt(claudeTimeout, 180),
    },
    codex: {
      model: codexModel,
      reasoningEffort: codexEffort,
      timeoutMinutes: parsePositiveInt(codexTimeout, 180),
    },
  };

  if (anthropicApiKey) config.anthropicApiKey = anthropicApiKey;
  if (linearApiKey) config.linearApiKey = linearApiKey;

  saveConfig(config);
  console.log(`\nconfig saved to ${CONFIG_PATH}`);
  console.log("run `oneshot <repo> \"<task>\"` to ship your first change\n");
};

const main = async () => {
  try {
    const parsed = parseArgs(process.argv.slice(2));

    if (parsed.command === "init") {
      await runInit();
      return;
    }

    if (parsed.command === "stats") {
      if (parsed.local) {
        runStats();
        return;
      }
      // Fall back to local stats when no config exists -- stats is read-only
      // and shouldn't require remote setup.
      let config: OneshotConfig;
      try {
        config = await loadConfig();
      } catch {
        runStats();
        return;
      }
      const proc = Bun.spawn(
        ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", config.host, buildRemoteStatsShellCommand()],
        { stdout: "inherit", stderr: "inherit", stdin: "inherit" }
      );
      await proc.exited;
      process.exit(proc.exitCode ?? 1);
      return;
    }

    if (parsed.command === "doctor") {
      let config: OneshotConfig | null = null;
      try {
        config = parsed.local ? await loadLocalConfig() : await loadConfig();
      } catch {
        if (parsed.local) config = await loadLocalConfig();
      }
      const report = await buildDoctorReport(config, { local: parsed.local, repo: parsed.doctorRepo });
      if (parsed.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        printDoctorReport(report);
      }
      process.exit(report.ok ? 0 : 1);
    }

    const config = parsed.local ? await loadLocalConfig() : await loadConfig();

    if (!parsed.local) {
      const parts = buildRemoteCommandParts({
        ...parsed,
        basePath: parsed.basePath ?? config.basePath,
      });

      if (parsed.bg) {
        const logFile = `/tmp/oneshot-${Date.now()}.log`;
        const remoteCmd = buildRemoteBackgroundShellCommand(parts, logFile);

        const proc = Bun.spawn(
          ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", config.host, remoteCmd],
          { stdout: "pipe", stderr: "inherit", stdin: "pipe" }
        );
        writeRemoteConfig(proc, config);

        const output = await new Response(proc.stdout).text();
        const exitCode = await proc.exited;
        if ((exitCode ?? 1) !== 0) {
          process.exit(exitCode ?? 1);
        }
        console.log(`shipped to background on server`);
        console.log(output.trim());
        console.log(`\ntail logs: ssh ${config.host} "tail -f ${logFile}"`);
        process.exit(0);
      }

      const proc = Bun.spawn(
        ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", config.host, buildRemoteShellCommand(parts)],
        { stdout: "inherit", stderr: "inherit", stdin: "pipe" }
      );
      writeRemoteConfig(proc, config);
      await proc.exited;
      process.exit(proc.exitCode ?? 1);
    }

    if (config.anthropicApiKey) {
      process.env.ANTHROPIC_API_KEY = config.anthropicApiKey;
    }

    // --local --bg: fork ourselves without --bg, redirect output to log file
    if (parsed.bg) {
      const logFile = `/tmp/oneshot-${Date.now()}.log`;
      const fd = openSync(logFile, "w");
      const child = Bun.spawn([process.argv[0], process.argv[1], ...buildLocalChildArgs(parsed)], {
        stdout: fd,
        stderr: fd,
        stdin: "ignore",
      });
      closeSync(fd);

      // detach from parent
      child.unref();

      console.log(`PID: ${child.pid}`);
      console.log(`LOG: ${logFile}`);
      console.log(`\ntail logs: tail -f ${logFile}`);
      process.exit(0);
    }

    const options: OneshotOptions = {
      repo: parsed.repo,
      task: parsed.task,
      model: parsed.model,
      branch: parsed.branch,
      basePath: parsed.basePath,
      worktreeRoot: parsed.worktreeRoot,
      mode: parsed.mode,
      dryRun: parsed.dryRun,
      deepReview: parsed.deepReview,
      eventsFile: parsed.eventsFile,
    };

    if (options.task && isLinearUrl(options.task)) {
      const issueId = extractIssueId(options.task);
      log.info(`fetching Linear issue ${issueId}...`);
      const issue = await fetchIssue(config, issueId);
      options.task = formatIssueAsTask(issue);
      options.taskSummary = `${issue.identifier}: ${issue.title}`;
      options.linearIssueId = issueId;
      log.info(`task: ${issue.identifier} - ${issue.title}`);
    }

    await runPipeline(config, options);
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
};

if (import.meta.main) {
  void main();
}
