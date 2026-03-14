#!/usr/bin/env bun

import { loadConfig, saveConfig, CONFIG_PATH } from "./config";
import type { OneshotConfig, OneshotOptions } from "./config";
import { runPipeline } from "./pipeline";
import { log } from "./log";
import { isLinearUrl, extractIssueId, fetchIssue, formatIssueAsTask } from "./linear";
import { existsSync, openSync } from "fs";

interface ParsedArgs extends OneshotOptions {
  local: boolean;
  bg: boolean;
  command?: string;
}

const parseArgs = (args: string[]): ParsedArgs => {
  if (args[0] === "init") {
    return { command: "init", repo: "", task: "", local: false, bg: false };
  }

  const positional: string[] = [];
  let model: string | undefined;
  let branch: string | undefined;
  let eventsFile: string | undefined;
  let dryRun = false;
  let local = false;
  let bg = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--model" || arg === "-m") {
      model = args[++i];
    } else if (arg === "--dry-run" || arg === "-d") {
      dryRun = true;
    } else if (arg === "--local") {
      local = true;
    } else if (arg === "--branch" || arg === "-b") {
      branch = args[++i];
    } else if (arg === "--events-file") {
      eventsFile = args[++i];
    } else if (arg === "--bg") {
      bg = true;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else if (arg === "--version" || arg === "-v") {
      console.log("oneshot v0.0.1");
      process.exit(0);
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    }
  }

  if (positional.length < 1) { log.error("missing repo argument"); printUsage(); process.exit(1); }
  if (positional.length < 2 && !dryRun) { log.error("missing task description or Linear URL"); printUsage(); process.exit(1); }

  return { repo: positional[0], task: positional[1] ?? "", model, branch, eventsFile, dryRun, local, bg };
};

const printUsage = () => {
  console.log(`
Usage: oneshot <repo> "<task or linear url>" [options]
       oneshot init

Commands:
  init                    Set up ~/.oneshot/config.json interactively

Options:
  --model, -m <model>     Override Claude model (default: from config)
  --branch, -b <branch>   Base branch to work from and PR into (default: main)
  --local                 Run locally instead of over SSH
  --dry-run, -d           Validate repo exists without running pipeline
  --events-file <path>    Write JSONL events to file (for structured progress tracking)
  --bg                    Run on server in background (fire and forget)
  --help, -h              Show this help
  --version, -v           Show version

Examples:
  oneshot init
  oneshot my-org/my-repo "fix the login bug"
  oneshot my-org/my-repo https://linear.app/team/issue/ABC-123/slug
  oneshot my-org/my-repo "add dark mode" --bg
  oneshot my-org/my-repo "fix staging bug" --branch staging
  oneshot my-org/my-repo --dry-run
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
  const codexModel = await prompt("  codex model (for execution + review)", "gpt-5.3-codex");
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
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.command === "init") {
    await runInit();
    return;
  }

  const config = await loadConfig();

  try {
    if (!parsed.local) {
      const escapedTask = parsed.task.replace(/'/g, "'\\''");
      const escapedRepo = parsed.repo.replace(/'/g, "'\\''");
      const parts = ["~/.bun/bin/oneshot", "--local", `'${escapedRepo}'`, `'${escapedTask}'`];
      if (parsed.model) parts.push("--model", `'${parsed.model.replace(/'/g, "'\\''")}'`);
      if (parsed.branch) parts.push("--branch", `'${parsed.branch.replace(/'/g, "'\\''")}'`);
      if (parsed.eventsFile) parts.push("--events-file", `'${parsed.eventsFile.replace(/'/g, "'\\''")}'`);
      if (parsed.dryRun) parts.push("--dry-run");

      if (parsed.bg) {
        const logFile = `/tmp/oneshot-${Date.now()}.log`;
        const remoteCmd = `nohup ${parts.join(" ")} > ${logFile} 2>&1 & echo "PID: $!" && echo "LOG: ${logFile}"`;

        const proc = Bun.spawn(
          ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", config.host, remoteCmd],
          { stdout: "pipe", stderr: "inherit" }
        );

        const output = await new Response(proc.stdout).text();
        await proc.exited;
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
      const args = ["--local", parsed.repo, parsed.task];
      if (parsed.model) args.push("--model", parsed.model);
      if (parsed.branch) args.push("--branch", parsed.branch);
      if (parsed.eventsFile) args.push("--events-file", parsed.eventsFile);

      const fd = openSync(logFile, "w");
      const child = Bun.spawn([process.argv[0], process.argv[1], ...args], {
        stdout: fd,
        stderr: fd,
        stdin: "ignore",
      });

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
      dryRun: parsed.dryRun,
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

main();
