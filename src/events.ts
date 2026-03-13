import { writeFileSync, appendFileSync } from "fs";

export interface StartedEvent {
  readonly type: "started";
  readonly runId: string;
  readonly repo: string;
  readonly task: string;
  readonly timestamp: number;
}

export interface StepEvent {
  readonly type: "step";
  readonly runId: string;
  readonly step: number;
  readonly label: string;
  readonly status: "running" | "done" | "failed";
  readonly elapsed?: number;
  readonly timestamp: number;
}

export interface CompletedEvent {
  readonly type: "completed";
  readonly runId: string;
  readonly prUrl?: string;
  readonly filesChanged?: number;
  readonly error?: string;
  readonly elapsed: number;
  readonly timestamp: number;
}

export type OneshotEvent = StartedEvent | StepEvent | CompletedEvent;

export class EventEmitter {
  private readonly filePath: string | null;
  readonly runId: string;

  constructor(eventsFile: string | null, runId: string) {
    this.runId = runId;
    this.filePath = eventsFile;
    if (this.filePath) {
      writeFileSync(this.filePath, "");
    }
  }

  emit(event: OneshotEvent): void {
    if (!this.filePath) return;
    try {
      appendFileSync(this.filePath, JSON.stringify(event) + "\n");
    } catch {
      // best effort - don't crash the pipeline for event writes
    }
  }

  started(repo: string, task: string): void {
    this.emit({ type: "started", runId: this.runId, repo, task, timestamp: Date.now() });
  }

  stepRunning(step: number, label: string): void {
    this.emit({ type: "step", runId: this.runId, step, label, status: "running", timestamp: Date.now() });
  }

  stepDone(step: number, label: string, elapsed: number): void {
    this.emit({ type: "step", runId: this.runId, step, label, status: "done", elapsed, timestamp: Date.now() });
  }

  stepFailed(step: number, label: string, elapsed: number): void {
    this.emit({ type: "step", runId: this.runId, step, label, status: "failed", elapsed, timestamp: Date.now() });
  }

  completed(opts: { prUrl?: string; filesChanged?: number; elapsed: number }): void {
    this.emit({ type: "completed", runId: this.runId, ...opts, timestamp: Date.now() });
  }

  failed(error: string, elapsed: number): void {
    this.emit({ type: "completed", runId: this.runId, error, elapsed, timestamp: Date.now() });
  }
}
