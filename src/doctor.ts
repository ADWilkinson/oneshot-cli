import { existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { CONFIG_PATH, type OneshotConfig } from "./config";
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

const agentHooksCheck = (): DoctorCheck => {
  const hooksHome = process.env.AGENT_HOOKS_HOME || join(process.env.HOME || "", ".agent-hooks");
  const commonHook = join(hooksHome, "hooks", "common.py");
  if (!existsSync(commonHook)) {
    return check("agent-hooks", "warn", `${commonHook} not found`);
  }
  return check("agent-hooks", "ok", `hook runtime found at ${hooksHome}`);
};

const remoteAgentHooksCheck = async (host: string): Promise<DoctorCheck> => {
  const probe = 'hooks_home="${AGENT_HOOKS_HOME:-$HOME/.agent-hooks}"; test -f "$hooks_home/hooks/common.py" && printf "%s" "$hooks_home"';
  const result = await exec(`ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new ${shellEscape(host)} ${shellEscape(probe)}`, {
    timeoutMs: 20_000,
  });
  if (result.exitCode !== 0) {
    return check("remote:agent-hooks", "warn", "agent hook runtime not found");
  }
  return check("remote:agent-hooks", "ok", `hook runtime found at ${result.stdout.trim()}`);
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

  const probe = [
    `base=${shellEscape(config.basePath)}`,
    `repo=${shellEscape(repo)}`,
    'path="$base/$repo"',
    'case "$path" in "~/"*) path="$HOME/${path#~/}" ;; esac',
    'test -d "$path/.git" || test -f "$path/.git"',
  ].join("; ");
  const result = await exec(`ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new ${shellEscape(host)} ${shellEscape(probe)}`, {
    timeoutMs: 20_000,
  });
  if (result.exitCode !== 0) {
    return check("remote:repo", "fail", `${repo} not found under ${config.basePath}`);
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
  return check("config", "ok", `basePath=${config.basePath}, worktreeRoot=${config.worktreeRoot ?? "/tmp"}`);
};

export const buildDoctorReport = async (
  config: OneshotConfig | null,
  opts: DoctorOptions = {},
): Promise<DoctorReport> => {
  const target = opts.local || !config || config.host === "local" ? "local" : "remote";
  const checks: DoctorCheck[] = [configCheck(config, target === "remote")];
  const packageCheck = await packageVersionCheck();
  checks.push(packageCheck.check);

  for (const command of ["bun", "git", "gh", "claude", "codex"]) {
    checks.push(await commandCheck(command));
  }
  checks.push(agentHooksCheck());
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
    for (const command of ["oneshot", "bun", "git", "gh", "claude", "codex"]) {
      checks.push(await remoteCommandCheck(config.host, command));
    }
    checks.push(await remoteAgentHooksCheck(config.host));
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
