import { existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { CONFIG_PATH, type OneshotConfig } from "./config";
import { exec } from "./exec";
import { shellEscape } from "./shell";
import { VERSION } from "./version";

export interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

export interface DoctorReport {
  version: string;
  target: "local" | "remote";
  host?: string;
  configPath: string;
  checks: DoctorCheck[];
  ok: boolean;
}

export interface DoctorOptions {
  local?: boolean;
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

  for (const command of ["bun", "git", "gh", "claude", "codex"]) {
    checks.push(await commandCheck(command));
  }
  checks.push(recentEventsCheck());

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
  }

  return {
    version: VERSION,
    target,
    host: target === "remote" ? config?.host : undefined,
    configPath: CONFIG_PATH,
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
