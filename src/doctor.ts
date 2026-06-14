import { existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { CONFIG_PATH, type AgentProvider, type OneshotConfig } from "./config";
import { exec } from "./exec";
import { shellEscape } from "./shell";
import { VERSION } from "./version";
import { resolveRepoPath, validateRepoSlug } from "./repo";

export interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

export interface DoctorReport {
  version: string;
  latestVersion?: string;
  target: "local" | "remote";
  host?: string;
  configPath: string;
  repo?: string;
  checks: DoctorCheck[];
  ok: boolean;
}

export interface DoctorOptions {
  local?: boolean;
  repo?: string;
}

const check = (name: string, status: DoctorCheck["status"], detail: string): DoctorCheck => ({
  name,
  status,
  detail,
});

const commandCheck = async (command: string): Promise<DoctorCheck> => {
  const result = await exec(`command -v ${shellEscape(command)} >/dev/null 2>&1 && ${shellEscape(command)} --version 2>&1 | head -1`, {
    timeoutMs: 10_000,
  });
  if (result.exitCode !== 0) return check(command, "fail", `${command} not found on PATH`);
  return check(command, "ok", result.stdout.trim() || `${command} found`);
};

const providerCommands = (config: OneshotConfig | null): AgentProvider[] => {
  if (config?.routing?.enabled) return ["codex", "claude"];
  return [config?.provider ?? "codex"];
};

const packageVersionCheck = async (): Promise<{ check: DoctorCheck; latestVersion?: string }> => {
  const result = await exec("npm view oneshot-ship version", { timeoutMs: 15_000 });
  if (result.exitCode !== 0) {
    return {
      check: check("package", "warn", `running v${VERSION}; npm latest unavailable`),
    };
  }

  const latestVersion = result.stdout.trim();
  if (!latestVersion) {
    return { check: check("package", "warn", `running v${VERSION}; npm returned no version`) };
  }
  if (latestVersion !== VERSION) {
    return {
      latestVersion,
      check: check("package", "warn", `running v${VERSION}; npm latest is v${latestVersion}`),
    };
  }
  return {
    latestVersion,
    check: check("package", "ok", `running latest v${VERSION}`),
  };
};

const remoteCommandCheck = async (host: string, command: string): Promise<DoctorCheck> => {
  const probe = [
    `command -v ${shellEscape(command)} >/dev/null 2>&1`,
    `${shellEscape(command)} --version 2>&1 | head -1`,
  ].join(" && ");
  const result = await exec(`ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new ${shellEscape(host)} ${shellEscape(probe)}`, {
    timeoutMs: 20_000,
  });
  if (result.exitCode !== 0) {
    return check(`remote:${command}`, "fail", (result.stderr || result.stdout || `${command} not found`).trim());
  }
  return check(`remote:${command}`, "ok", result.stdout.trim() || `${command} found`);
};

const localRepoCheck = (config: OneshotConfig | null, repo: string): DoctorCheck => {
  try {
    validateRepoSlug(repo);
    const basePath = config?.basePath ?? "~/projects";
    const repoPath = resolveRepoPath(basePath, repo);
    if (existsSync(join(repoPath, ".git"))) {
      return check("repo", "ok", `${repo} found at ${repoPath}`);
    }
    return check("repo", "fail", `${repo} not found at ${repoPath}`);
  } catch (err) {
    return check("repo", "fail", err instanceof Error ? err.message : String(err));
  }
};

const remoteRepoCheck = async (host: string, config: OneshotConfig, repo: string): Promise<DoctorCheck> => {
  try {
    validateRepoSlug(repo);
  } catch (err) {
    return check("remote:repo", "fail", err instanceof Error ? err.message : String(err));
  }

  // Mirror resolveRepoPath's nested-then-flat fallback on the remote host.
  const probe = [
    `base=${shellEscape(config.basePath)}`,
    `repo=${shellEscape(repo)}`,
    'name="${repo#*/}"',
    'found=1',
    'for path in "$base/$repo" "$base/$name"; do',
    '  case "$path" in "~/"*) path="$HOME/${path#~/}" ;; esac',
    '  if test -d "$path/.git" || test -f "$path/.git"; then found=0; break; fi',
    'done',
    'exit $found',
  ].join("; ");
  const result = await exec(`ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new ${shellEscape(host)} ${shellEscape(probe)}`, {
    timeoutMs: 20_000,
  });
  if (result.exitCode !== 0) {
    return check("remote:repo", "fail", `${repo} not found under ${config.basePath} (nested or flat)`);
  }
  return check("remote:repo", "ok", `${repo} found under ${config.basePath}`);
};

const recentEventsCheck = (): DoctorCheck => {
  try {
    const events = readdirSync("/tmp")
      .filter((name) => name.startsWith("oneshot-") && name.endsWith(".events.jsonl"))
      .map((name) => {
        const path = join("/tmp", name);
        return { name, mtimeMs: statSync(path).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (events.length === 0) return check("events", "warn", "no /tmp/oneshot-*.events.jsonl files found yet");
    return check("events", "ok", `${events.length} event file(s), latest ${events[0].name}`);
  } catch (err) {
    return check("events", "warn", `could not scan /tmp events: ${err}`);
  }
};

const configCheck = (config: OneshotConfig | null, requireHost: boolean): DoctorCheck => {
  if (!existsSync(CONFIG_PATH)) {
    return requireHost
      ? check("config", "fail", `missing ${CONFIG_PATH}; run oneshot init`)
      : check("config", "warn", `missing ${CONFIG_PATH}; local mode can still run with defaults`);
  }
  if (!config) return check("config", "fail", `could not load ${CONFIG_PATH}`);
  return check("config", "ok", `provider=${config.provider}, basePath=${config.basePath}, worktreeRoot=${config.worktreeRoot ?? "/tmp"}`);
};

export const buildDoctorReport = async (
  config: OneshotConfig | null,
  opts: DoctorOptions = {},
): Promise<DoctorReport> => {
  const target = opts.local || !config || config.host === "local" ? "local" : "remote";
  const agentCommands = providerCommands(config);
  const checks: DoctorCheck[] = [configCheck(config, target === "remote")];
  const packageCheck = await packageVersionCheck();
  checks.push(packageCheck.check);

  for (const command of ["bun", "git", "gh", ...agentCommands]) {
    checks.push(await commandCheck(command));
  }
  checks.push(recentEventsCheck());

  if (opts.repo && target === "local") {
    checks.push(localRepoCheck(config, opts.repo));
  }

  if (target === "remote" && config?.host) {
    const ssh = await exec(`ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new ${shellEscape(config.host)} true`, {
      timeoutMs: 20_000,
    });
    checks.push(
      ssh.exitCode === 0
        ? check("ssh", "ok", `connected to ${config.host}`)
        : check("ssh", "fail", (ssh.stderr || ssh.stdout || `failed to connect to ${config.host}`).trim())
    );
    for (const command of ["oneshot", "bun", "git", "gh", ...agentCommands]) {
      checks.push(await remoteCommandCheck(config.host, command));
    }
    if (opts.repo) {
      checks.push(await remoteRepoCheck(config.host, config, opts.repo));
    }
  }

  return {
    version: VERSION,
    latestVersion: packageCheck.latestVersion,
    target,
    host: target === "remote" ? config?.host : undefined,
    configPath: CONFIG_PATH,
    repo: opts.repo,
    checks,
    ok: checks.every((item) => item.status !== "fail"),
  };
};

const label = (status: DoctorCheck["status"]): string => {
  if (status === "ok") return "ok";
  if (status === "warn") return "warn";
  return "fail";
};

export const printDoctorReport = (report: DoctorReport): void => {
  console.log(`\noneshot doctor v${report.version}`);
  console.log(`target: ${report.target}${report.host ? ` (${report.host})` : ""}`);
  console.log(`config: ${report.configPath}\n`);
  for (const item of report.checks) {
    console.log(`${label(item.status).padEnd(5)} ${item.name.padEnd(16)} ${item.detail}`);
  }
  console.log("");
};
