import { writeFileSync, appendFileSync } from "fs";

export interface StartedEvent {
  readonly type: "started";
  readonly runId: string;
  readonly repo: string;
  readonly task: string;
  readonly mode?: string;
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

export type OneshotEvent = StartedEvent | StepEvent | CompletedEvent | ClassifiedEvent;

export class EventWriter {
  private filePath: string | null;
  private writeFailed = false;
  readonly runId: string;

  constructor(eventsFile: string | null, runId: string) {
    this.runId = runId;
    this.filePath = eventsFile;
    if (this.filePath) {
      try {
        writeFileSync(this.filePath, "");
      } catch (err) {
        process.stderr.write(`[oneshot] warning: cannot write events file "${this.filePath}": ${err}\n`);
        this.filePath = null;
      }
    }
  }

  emit(event: OneshotEvent): void {
    if (!this.filePath) return;
    try {
      appendFileSync(this.filePath, JSON.stringify(event) + "\n");
      this.writeFailed = false;
    } catch (err) {
      // Best effort - don't crash the pipeline for event writes, but warn once
      if (!this.writeFailed) {
        process.stderr.write(`[oneshot] warning: failed to write event: ${err}\n`);
        this.writeFailed = true;
      }
    }
  }

  started(repo: string, task: string, mode?: string): void {
    this.emit({ type: "started", runId: this.runId, repo, task, mode, timestamp: Date.now() });
  }

  classified(mode: string): void {
    this.emit({ type: "classified", runId: this.runId, mode, timestamp: Date.now() });
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

  completed(opts: { prUrl?: string; filesChanged?: number; elapsed: number; diffStats?: Array<{ file: string; additions: number; deletions: number }>; stepTimings?: Array<{ step: number; label: string; elapsed: number }> }): void {
    this.emit({ type: "completed", runId: this.runId, ...opts, timestamp: Date.now() });
  }

  failed(error: string, elapsed: number, errorCode?: string, errorDetail?: string): void {
    this.emit({ type: "completed", runId: this.runId, error, elapsed, errorCode, errorDetail, timestamp: Date.now() });
  }
}
