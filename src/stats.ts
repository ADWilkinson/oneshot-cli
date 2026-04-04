import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { CONFIG_DIR } from "./config";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";

const HISTORY_FILES = [join(CONFIG_DIR, "history.json")];

interface CompletedRun {
  runId: string;
  repo: string;
  task: string;
  result: "success" | "failed" | "dry-run" | "unknown";
  prUrl?: string;
  error?: string;
  elapsed: number;
  timestamp: number;
  stepTimings: Array<{ step: number; label: string; elapsed: number }>;
  failedStep?: { step: number; label: string };
}

interface RepoHistory {
  [repo: string]: number[];
}

interface EventLine {
  type: string;
  runId?: string;
  repo?: string;
  task?: string;
  step?: number;
  label?: string;
  status?: string;
  elapsed?: number;
  prUrl?: string;
  error?: string;
  result?: string;
  timestamp?: number;
  filesChanged?: number;
}

const formatTime = (ms: number): string => {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  if (remaining === 0) return `${minutes}m`;
  return `${minutes}m ${remaining}s`;
};

const formatTimeAgo = (timestamp: number): string => {
  const ms = Date.now() - timestamp;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
};

const pad = (s: string, len: number): string => s.padEnd(len);

function scanRecentRuns(): CompletedRun[] {
  const runs: CompletedRun[] = [];

  try {
    const files = readdirSync("/tmp")
      .filter(f => f.startsWith("oneshot-") && f.endsWith(".events.jsonl"))
      .map(f => { try { return { name: f, path: `/tmp/${f}`, mtime: statSync(`/tmp/${f}`).mtimeMs }; } catch { return null; } })
      .filter((f): f is NonNullable<typeof f> => f !== null)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 30);

    for (const file of files) {
      try {
        const raw = readFileSync(file.path, "utf-8").trim();
        if (!raw) continue;

        const events: EventLine[] = raw
          .split("\n")
          .map(line => { try { return JSON.parse(line); } catch { return null; } })
          .filter((e): e is EventLine => e !== null);

        const started = events.find(e => e.type === "started");
        const completed = events.find(e => e.type === "completed");
        if (!completed) continue;
        const result =
          completed.result === "success" || completed.result === "failed" || completed.result === "dry-run"
            ? completed.result
            : completed.prUrl
              ? "success"
              : completed.error
                ? "failed"
                : "unknown";

        const stepTimings = events
          .filter(e => e.type === "step" && e.status === "done" && e.step != null && e.label != null && e.elapsed != null)
          .map(e => ({ step: e.step!, label: e.label!, elapsed: e.elapsed! }));

        const failed = events.find(e => e.type === "step" && e.status === "failed" && e.step != null && e.label != null);

        runs.push({
          runId: started?.runId ?? "unknown",
          repo: started?.repo ?? "unknown",
          task: started?.task?.slice(0, 80) ?? "",
          result,
          prUrl: completed.prUrl,
          error: completed.error,
          elapsed: completed.elapsed ?? 0,
          timestamp: completed.timestamp ?? file.mtime,
          stepTimings,
          failedStep: failed ? { step: failed.step!, label: failed.label! } : undefined,
        });
      } catch {
        // skip corrupted files
      }
    }
  } catch {
    // /tmp not accessible
  }

  return runs.sort((a, b) => b.timestamp - a.timestamp);
}

function loadHistory(): RepoHistory {
  const merged: RepoHistory = {};

  for (const historyFile of HISTORY_FILES) {
    try {
      if (!existsSync(historyFile)) continue;
      const history = JSON.parse(readFileSync(historyFile, "utf-8")) as RepoHistory;
      for (const [repo, durations] of Object.entries(history)) {
        if (!Array.isArray(durations)) continue;
        if (!merged[repo]) merged[repo] = [];
        merged[repo].push(...durations.filter((duration) => typeof duration === "number" && duration > 0));
      }
    } catch {
      // ignore malformed history files
    }
  }

  return merged;
}

export const runStats = (): void => {
  console.log(`\n${BOLD}${CYAN}oneshot stats${RESET}\n`);

  // Recent runs
  const runs = scanRecentRuns();
  if (runs.length > 0) {
    const display = runs.slice(0, 15);
    console.log(`${BOLD}Recent runs (${display.length}/${runs.length})${RESET}`);
    for (const run of display) {
      const status = run.result === "dry-run"
        ? `${CYAN}\u25cf${RESET} dry run complete`
        : run.prUrl
        ? `${GREEN}\u2713${RESET} PR delivered`
        : run.failedStep
          ? `${RED}\u2717${RESET} failed step ${run.failedStep.step} (${shortStep(run.failedStep.label)})`
          : run.error
            ? `${RED}\u2717${RESET} failed`
            : `${YELLOW}?${RESET} unknown`;

      const repoDisplay = run.repo.length > 28 ? run.repo.slice(0, 28) + ".." : run.repo;
      const timeDisplay = formatTime(run.elapsed);
      const agoDisplay = formatTimeAgo(run.timestamp);

      console.log(`  ${pad(repoDisplay, 30)} ${pad(timeDisplay, 10)} ${status}  ${DIM}${agoDisplay}${RESET}`);
    }
    console.log();
  } else {
    console.log(`${DIM}No recent runs found yet.${RESET}`);
    console.log(`${DIM}Run \`oneshot <repo> --dry-run\` to verify setup or ship a task to generate your first event log.${RESET}\n`);
  }

  // Per-repo averages
  const history = loadHistory();
  const repos = Object.keys(history).sort();
  if (repos.length > 0) {
    console.log(`${BOLD}Per-repo averages${RESET}`);

    const finishedRuns = runs.filter(r => r.result === "success" || r.result === "failed");
    const successCount = finishedRuns.filter(r => r.result === "success").length;
    const failCount = finishedRuns.filter(r => r.result === "failed").length;
    const totalRuns = successCount + failCount;
    const successRate = totalRuns > 0 ? Math.round((successCount / totalRuns) * 100) : 0;

    if (totalRuns > 0) {
      const rateColor = successRate >= 80 ? GREEN : successRate >= 50 ? YELLOW : RED;
      console.log(`  ${DIM}success rate:${RESET} ${rateColor}${successRate}%${RESET} ${DIM}(${successCount}/${totalRuns})${RESET}`);
      console.log();
    }

    for (const repo of repos) {
      const durations = history[repo];
      if (!durations || durations.length === 0) continue;
      const avg = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
      const min = Math.min(...durations);
      const max = Math.max(...durations);
      console.log(
        `  ${pad(repo, 30)} ${BOLD}${pad(formatTime(avg), 10)}${RESET} avg  ${DIM}${formatTime(min)}-${formatTime(max)}${RESET}  ${DIM}(${durations.length} runs)${RESET}`
      );
    }
    console.log();
  }
};

function shortStep(label: string): string {
  return label
    .replace("Validating repo", "validate")
    .replace("Creating worktree", "worktree")
    .replace("Classifying task", "classify")
    .replace("Planning with Claude", "plan")
    .replace("Executing with Codex", "execute")
    .replace("Creating draft PR", "draft PR")
    .replace("Reviewing with Codex", "review")
    .replace("Finalizing PR", "finalize PR")
    .replace("Creating PR", "PR");
}
