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

export interface ParsedArgs extends OneshotOptions {
  local: boolean;
  bg: boolean;
  command?: string;
  deepReview: boolean;
}

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
    return { command: "init", repo: "", task: "", local: false, bg: false, deepReview: false };
  }

  if (args[0] === "stats") {
    return { command: "stats", repo: "", task: "", local: args.includes("--local"), bg: false, deepReview: false };
  }

  const positional: string[] = [];
  let model: string | undefined;
  let branch: string | undefined;
  let mode: ComplexityMode | undefined;
  let eventsFile: string | undefined;
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
    } else if (arg === "--events-file") {
      eventsFile = getFlagValue(args, i, arg);
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

  return {
    repo: positional[0],
    task: positional[1] ?? "",
    model,
    branch,
    mode,
    eventsFile,
    dryRun,
    deepReview,
    local,
    bg,
  };
};

export const buildRemoteCommandParts = (parsed: ParsedArgs): string[] => {
  const parts = ["~/.bun/bin/oneshot", "--local", shellEscape(parsed.repo)];
  if (parsed.task) parts.push(shellEscape(parsed.task));
  if (parsed.model) parts.push("--model", shellEscape(parsed.model));
  if (parsed.branch) parts.push("--branch", shellEscape(parsed.branch));
  if (parsed.mode) parts.push("--mode", shellEscape(parsed.mode));
  if (parsed.eventsFile) parts.push("--events-file", shellEscape(parsed.eventsFile));
  if (parsed.dryRun) parts.push("--dry-run");
  if (parsed.deepReview) parts.push("--deep-review");
  return parts;
};

export const buildLocalChildArgs = (parsed: ParsedArgs): string[] => {
  const args = ["--local", parsed.repo];
  if (parsed.task) args.push(parsed.task);
  if (parsed.model) args.push("--model", parsed.model);
  if (parsed.branch) args.push("--branch", parsed.branch);
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

Commands:
  init                    Set up ~/.oneshot/config.json interactively
  stats                   Show recent runs, success rates, per-repo averages

Options:
  --model, -m <model>     Override Claude model (default: from config)
  --branch, -b <branch>   Base branch to work from and PR into (default: main)
  --mode <fast|deep>      Skip classification and force the requested review mode
  --deep-review           Force deep review mode
  --local                 Run locally instead of over SSH
  --dry-run, -d           Validate repo exists without running pipeline
  --events-file <path>    Mirror JSONL events to an additional file
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

  console.log("\napi keys (stored in ~/.oneshot/config.json):\n");

  const anthropicApiKey = await prompt("  anthropic api key (optional, or set ANTHROPIC_API_KEY on server)");
  const linearApiKey = await prompt("  linear api key (optional, for ticket integration)");

  console.log("\nmodel defaults:\n");

  const claudeModel = await prompt("  claude model (for planning + PR)", "opus");
  const claudeTimeout = await prompt("  claude timeout in minutes", "180");
  const codexModel = await prompt("  codex model (for execution + review)", "gpt-5.4-mini");
  const codexEffort = await prompt("  codex reasoning effort", "xhigh");
  const codexTimeout = await prompt("  codex timeout in minutes", "180");

  const config: OneshotConfig = {
    host,
    basePath,
    claude: {
      model: claudeModel,
      timeoutMinutes: parseInt(claudeTimeout, 10) || 180,
    },
    codex: {
      model: codexModel,
      reasoningEffort: codexEffort,
      timeoutMinutes: parseInt(codexTimeout, 10) || 180,
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
      const config = await loadConfig();
      const proc = Bun.spawn(
        ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", config.host, "~/.bun/bin/oneshot stats --local"],
        { stdout: "inherit", stderr: "inherit", stdin: "inherit" }
      );
      await proc.exited;
      process.exit(proc.exitCode ?? 1);
      return;
    }

    const config = parsed.local ? await loadLocalConfig() : await loadConfig();

    if (!parsed.local) {
      const parts = buildRemoteCommandParts(parsed);

      if (parsed.bg) {
        const logFile = `/tmp/oneshot-${Date.now()}.log`;
        const remoteCmd = `nohup ${parts.join(" ")} > ${logFile} 2>&1 & echo "PID: $!" && echo "LOG: ${logFile}"`;

        const proc = Bun.spawn(
          ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", config.host, remoteCmd],
          { stdout: "pipe", stderr: "inherit" }
        );

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
        ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", config.host, parts.join(" ")],
        { stdout: "inherit", stderr: "inherit", stdin: "inherit" }
      );
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
