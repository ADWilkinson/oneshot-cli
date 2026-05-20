import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "fs";
import { basename, join } from "path";
import { CONFIG_DIR } from "./config";
import type { OneshotEvent } from "./events";

export const RUNS_DIR = join(CONFIG_DIR, "runs");

export interface RunSnapshot {
  runId: string;
  repo: string;
  task: string;
  status: "running" | "success" | "failed" | "dry-run" | "unknown";
  eventsFile: string;
  prUrl?: string;
  error?: string;
  elapsed?: number;
  filesChanged?: number;
  startedAt?: number;
  updatedAt: number;
  runtime?: Record<string, unknown>;
  currentStep?: { step: number; label: string; status: string };
  changedFiles: string[];
  recentActions: Array<{ kind: string; title: string; ok?: boolean; timestamp: number }>;
}

interface RawEvent {
  type?: string;
  runId?: string;
  repo?: string;
  task?: string;
  status?: string;
  result?: string;
  step?: number;
  label?: string;
  prUrl?: string;
  error?: string;
  elapsed?: number;
  filesChanged?: number;
  timestamp?: number;
  runtime?: Record<string, unknown>;
  kind?: string;
  title?: string;
  ok?: boolean;
  detail?: {
    changes?: Array<{ path?: string }>;
  };
}

export const getLedgerEventsFile = (runId: string): string => join(RUNS_DIR, `${runId}.events.jsonl`);

const parseEvents = (eventsFile: string): RawEvent[] => {
  const raw = readFileSync(eventsFile, "utf-8").trim();
  if (!raw) return [];
  return raw
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line) as RawEvent;
      } catch {
        return null;
      }
    })
    .filter((event): event is RawEvent => event !== null);
};

const statusFromEvents = (events: RawEvent[]): RunSnapshot["status"] => {
  const completed = events.find((event) => event.type === "completed");
  if (!completed) return "running";
  if (completed.result === "success" || completed.result === "failed" || completed.result === "dry-run") {
    return completed.result;
  }
  return completed.prUrl ? "success" : completed.error ? "failed" : "unknown";
};

export const snapshotFromEvents = (eventsFile: string, recentActions = 8): RunSnapshot => {
  const events = parseEvents(eventsFile);
  const started = events.find((event) => event.type === "started");
  const completed = [...events].reverse().find((event) => event.type === "completed");
  const currentStep = [...events].reverse().find((event) => event.type === "step");
  const agentEvents = events.filter((event) => event.type === "agent");
  const changedFiles = new Set<string>();

  for (const event of agentEvents) {
    for (const change of event.detail?.changes ?? []) {
      if (change.path) changedFiles.add(change.path);
    }
  }
  for (const stat of (completed as { diffStats?: Array<{ file?: string }> } | undefined)?.diffStats ?? []) {
    if (stat.file) changedFiles.add(stat.file);
  }

  const fallbackId = basename(eventsFile).replace(/^oneshot-/, "").replace(/\.events\.jsonl$/, "");
  const fileMtime = statSync(eventsFile).mtimeMs;
  return {
    runId: started?.runId ?? completed?.runId ?? fallbackId,
    repo: started?.repo ?? "unknown",
    task: started?.task ?? "",
    status: statusFromEvents(events),
    eventsFile,
    prUrl: completed?.prUrl,
    error: completed?.error,
    elapsed: completed?.elapsed,
    filesChanged: completed?.filesChanged,
    startedAt: started?.timestamp,
    updatedAt: completed?.timestamp ?? currentStep?.timestamp ?? fileMtime,
    runtime: started?.runtime,
    currentStep: currentStep?.step && currentStep.label && currentStep.status
      ? { step: currentStep.step, label: currentStep.label, status: currentStep.status }
      : undefined,
    changedFiles: Array.from(changedFiles).sort(),
    recentActions: agentEvents.slice(-recentActions).reverse().map((event) => ({
      kind: event.kind ?? "note",
      title: event.title ?? "agent action",
      ok: event.ok,
      timestamp: event.timestamp ?? 0,
    })),
  };
};

export const resolveRunEventsFile = (runIdOrPath: string): string => {
  if (runIdOrPath.includes("/")) {
    if (!existsSync(runIdOrPath)) throw new Error(`events file not found: ${runIdOrPath}`);
    return runIdOrPath;
  }

  const ledgerPath = getLedgerEventsFile(runIdOrPath);
  if (existsSync(ledgerPath)) return ledgerPath;

  const tmpPath = `/tmp/oneshot-${runIdOrPath}.events.jsonl`;
  if (existsSync(tmpPath)) return tmpPath;

  throw new Error(`run not found: ${runIdOrPath}`);
};

export const listRunSnapshots = (limit = 20): RunSnapshot[] => {
  const candidates: string[] = [];
  for (const dir of [RUNS_DIR, "/tmp"]) {
    try {
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        if (!name.startsWith("oneshot-") && dir === "/tmp") continue;
        if (!name.endsWith(".events.jsonl")) continue;
        candidates.push(join(dir, name));
      }
    } catch {
      // best effort
    }
  }

  const unique = Array.from(new Set(candidates));
  return unique
    .map((file) => {
      try {
        return snapshotFromEvents(file);
      } catch {
        return null;
      }
    })
    .filter((snapshot): snapshot is RunSnapshot => snapshot !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
};

const formatTime = (ms?: number): string => {
  if (!ms) return "-";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

export const printRuns = (runs: RunSnapshot[]): void => {
  if (runs.length === 0) {
    console.log("No oneshot runs found.");
    return;
  }
  for (const run of runs) {
    const marker = run.status === "success" ? "ok" : run.status === "failed" ? "fail" : run.status;
    console.log(`${marker.padEnd(7)} ${run.runId.padEnd(20)} ${formatTime(run.elapsed).padEnd(8)} ${run.repo}  ${run.task.slice(0, 80)}`);
  }
};

export const ensureRunsDir = (): void => {
  mkdirSync(RUNS_DIR, { recursive: true });
};

export const summarizeEval = (runs = listRunSnapshots(100)): Record<string, unknown> => {
  const finished = runs.filter((run) => run.status === "success" || run.status === "failed");
  const successes = finished.filter((run) => run.status === "success");
  const failures = finished.filter((run) => run.status === "failed");
  const byRepo: Record<string, { runs: number; success: number; failed: number; avgElapsedMs: number }> = {};

  for (const run of finished) {
    const bucket = byRepo[run.repo] ?? { runs: 0, success: 0, failed: 0, avgElapsedMs: 0 };
    bucket.runs += 1;
    if (run.status === "success") bucket.success += 1;
    if (run.status === "failed") bucket.failed += 1;
    bucket.avgElapsedMs += run.elapsed ?? 0;
    byRepo[run.repo] = bucket;
  }

  for (const bucket of Object.values(byRepo)) {
    bucket.avgElapsedMs = bucket.runs > 0 ? Math.round(bucket.avgElapsedMs / bucket.runs) : 0;
  }

  return {
    totalRuns: runs.length,
    finishedRuns: finished.length,
    successRate: finished.length > 0 ? Math.round((successes.length / finished.length) * 100) : null,
    successes: successes.length,
    failures: failures.length,
    running: runs.filter((run) => run.status === "running").length,
    byRepo,
    latest: runs.slice(0, 10).map((run) => ({
      runId: run.runId,
      repo: run.repo,
      status: run.status,
      elapsed: run.elapsed,
      prUrl: run.prUrl,
      task: run.task,
    })),
  };
};

export type { OneshotEvent };
