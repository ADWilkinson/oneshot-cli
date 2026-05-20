import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "fs";
import { dirname } from "path";
import { ensureRunsDir, getLedgerEventsFile } from "./runs";

const EVENTS_REAP_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

const reapOldEventsFiles = (): void => {
  try {
    const now = Date.now();
    for (const name of readdirSync("/tmp")) {
      if (!name.startsWith("oneshot-") || !name.endsWith(".events.jsonl")) continue;
      const path = `/tmp/${name}`;
      try {
        const { mtimeMs } = statSync(path);
        if (now - mtimeMs > EVENTS_REAP_MAX_AGE_MS) unlinkSync(path);
      } catch {
        // best effort
      }
    }
  } catch {
    // /tmp not accessible or readdir failed -- never throw from reaper
  }
};

reapOldEventsFiles();

export interface StartedEvent {
  readonly type: "started";
  readonly runId: string;
  readonly repo: string;
  readonly task: string;
  readonly mode?: string;
  readonly runtime?: {
    readonly cliVersion?: string;
    readonly host?: string;
    readonly pid?: number;
    readonly cwd?: string;
    readonly platform?: string;
    readonly node?: string;
    readonly worktreeRoot?: string;
    readonly basePath?: string;
    readonly remote?: boolean;
  };
  readonly timestamp: number;
}

export interface StepEvent {
  readonly type: "step";
  readonly runId: string;
  readonly step: number;
  readonly label: string;
  readonly status: "running" | "done" | "failed";
  readonly elapsed?: number;
  readonly errorCode?: string;
  readonly errorDetail?: string;
  readonly timestamp: number;
}

export interface CompletedEvent {
  readonly type: "completed";
  readonly runId: string;
  readonly result: "success" | "failed" | "dry-run";
  readonly prUrl?: string;
  readonly filesChanged?: number;
  readonly error?: string;
  readonly errorCode?: string;
  readonly errorDetail?: string;
  readonly diffStats?: Array<{ file: string; additions: number; deletions: number }>;
  readonly stepTimings?: Array<{ step: number; label: string; elapsed: number }>;
  readonly elapsed: number;
  readonly timestamp: number;
}

export interface ClassifiedEvent {
  readonly type: "classified";
  readonly runId: string;
  readonly mode: string;
  readonly timestamp: number;
}

export type AgentEventPhase = "started" | "updated" | "completed";

export type AgentEventKind =
  | "command"
  | "file_change"
  | "note"
  | "pr"
  | "session"
  | "todo"
  | "tool"
  | "turn"
  | "warning"
  | "web_search";

export interface AgentActionEvent {
  readonly type: "agent";
  readonly runId: string;
  readonly step: number;
  readonly label: string;
  readonly source: "codex";
  readonly phase: AgentEventPhase;
  readonly kind: AgentEventKind;
  readonly title: string;
  readonly ok?: boolean;
  readonly detail?: Record<string, unknown>;
  readonly timestamp: number;
}

export interface AgentActionPayload {
  readonly phase: AgentEventPhase;
  readonly kind: AgentEventKind;
  readonly title: string;
  readonly ok?: boolean;
  readonly detail?: Record<string, unknown>;
}

export type OneshotEvent =
  | StartedEvent
  | StepEvent
  | CompletedEvent
  | ClassifiedEvent
  | AgentActionEvent;

export const getDefaultEventsFile = (runId: string): string => {
  return `/tmp/oneshot-${runId}.events.jsonl`;
};

export class EventWriter {
  private filePaths: string[];
  private writeFailed = new Set<string>();
  readonly runId: string;

  constructor(eventsFile: string | null, runId: string) {
    this.runId = runId;
    const candidates = [getDefaultEventsFile(runId), eventsFile].filter(
      (path, index, paths): path is string => !!path && paths.indexOf(path) === index
    );
    try {
      ensureRunsDir();
      candidates.push(getLedgerEventsFile(runId));
    } catch {
      // best effort; /tmp remains the compatibility event stream
    }
    this.filePaths = [];

    for (const filePath of candidates) {
      try {
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, "");
        this.filePaths.push(filePath);
      } catch (err) {
        process.stderr.write(`[oneshot] warning: cannot write events file "${filePath}": ${err}\n`);
      }
    }
  }

  emit(event: OneshotEvent): void {
    if (this.filePaths.length === 0) return;

    for (const filePath of this.filePaths) {
      try {
        appendFileSync(filePath, JSON.stringify(event) + "\n");
        this.writeFailed.delete(filePath);
      } catch (err) {
        // Best effort - don't crash the pipeline for event writes, but warn once per path
        if (!this.writeFailed.has(filePath)) {
          process.stderr.write(`[oneshot] warning: failed to write event to "${filePath}": ${err}\n`);
          this.writeFailed.add(filePath);
        }
      }
    }
  }

  started(repo: string, task: string, mode?: string, runtime?: StartedEvent["runtime"]): void {
    this.emit({ type: "started", runId: this.runId, repo, task, mode, runtime, timestamp: Date.now() });
  }

  classified(mode: string): void {
    this.emit({ type: "classified", runId: this.runId, mode, timestamp: Date.now() });
  }

  agentAction(step: number, label: string, action: AgentActionPayload): void {
    this.emit({
      type: "agent",
      runId: this.runId,
      step,
      label,
      source: "codex",
      ...action,
      timestamp: Date.now(),
    });
  }

  stepRunning(step: number, label: string): void {
    this.emit({ type: "step", runId: this.runId, step, label, status: "running", timestamp: Date.now() });
  }

  stepDone(step: number, label: string, elapsed: number): void {
    this.emit({ type: "step", runId: this.runId, step, label, status: "done", elapsed, timestamp: Date.now() });
  }

  stepFailed(step: number, label: string, elapsed: number, errorCode?: string, errorDetail?: string): void {
    this.emit({ type: "step", runId: this.runId, step, label, status: "failed", elapsed, errorCode, errorDetail, timestamp: Date.now() });
  }

  completed(opts: {
    result?: "success" | "dry-run";
    prUrl?: string;
    filesChanged?: number;
    elapsed: number;
    diffStats?: Array<{ file: string; additions: number; deletions: number }>;
    stepTimings?: Array<{ step: number; label: string; elapsed: number }>;
  }): void {
    this.emit({
      type: "completed",
      runId: this.runId,
      ...opts,
      result: opts.result ?? "success",
      timestamp: Date.now(),
    });
  }

  failed(
    error: string,
    elapsed: number,
    errorCode?: string,
    errorDetail?: string,
    stepTimings?: Array<{ step: number; label: string; elapsed: number }>,
  ): void {
    this.emit({
      type: "completed",
      runId: this.runId,
      result: "failed",
      error,
      elapsed,
      errorCode,
      errorDetail,
      stepTimings,
      timestamp: Date.now(),
    });
  }
}
