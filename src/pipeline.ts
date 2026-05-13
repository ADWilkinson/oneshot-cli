import type { PipelineContext, OneshotConfig, OneshotOptions } from "./config";
import { CONFIG_DIR } from "./config";
import { join } from "path";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { hostname } from "os";
import { log } from "./log";
import { formatTime } from "./log";
import { EventWriter } from "./events";
import { OneshotError, exec } from "./exec";
import { VERSION } from "./version";
import { expandHome } from "./path-utils";
import { validate } from "./steps/validate";
import { createWorktree, removeWorktree } from "./steps/worktree";
import { classify } from "./steps/classify";
import { plan } from "./steps/plan";
import { execute } from "./steps/execute";
import { review } from "./steps/review";
import { createDraftPr, finalizeAfterReview, getFilesChanged, getDiffStats } from "./steps/pr";
import { moveToInReview, addPrComment } from "./linear";
import { getStepLabel } from "./pipeline-steps";

const buildContext = (config: OneshotConfig, options: OneshotOptions): PipelineContext => {
  const basePath = expandHome(options.basePath ?? config.basePath);
  const worktreeRoot = expandHome(options.worktreeRoot ?? config.worktreeRoot ?? "/tmp");
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return {
    config,
    options,
    runId: id,
    repoPath: `${basePath}/${options.repo}`,
    worktreePath: `${worktreeRoot.replace(/\/+$/, "")}/oneshot-${id}`,
    worktreeRoot,
    plan: "",
    prUrl: "",
    startTime: Date.now(),
    mode: 'deep',
  };
};

interface StepTiming {
  step: number;
  label: string;
  elapsed: number;
}

const runStep = async (
  step: number,
  events: EventWriter,
  timings: StepTiming[],
  fn: () => Promise<void>,
): Promise<void> => {
  const label = getStepLabel(step);
  log.stepStart(step, label);
  events.stepRunning(step, label);
  const start = Date.now();
  try {
    await fn();
    const elapsed = Date.now() - start;
    log.stepDone(elapsed);
    events.stepDone(step, label, elapsed);
    timings.push({ step, label, elapsed });
  } catch (err) {
    const elapsed = Date.now() - start;
    log.stepFail(elapsed);
    const errorCode = err instanceof OneshotError ? err.code : undefined;
    const errorDetail = err instanceof OneshotError ? err.detail : undefined;
    events.stepFailed(step, label, elapsed, errorCode, errorDetail);
    throw err;
  }
};

export const runPipeline = async (config: OneshotConfig, options: OneshotOptions): Promise<void> => {
  const ctx = buildContext(config, options);
  const events = new EventWriter(options.eventsFile ?? null, ctx.runId);
  const stepTimings: StepTiming[] = [];

  events.started(options.repo, options.task, undefined, {
    cliVersion: VERSION,
    host: hostname(),
    platform: process.platform,
    node: process.version,
    worktreeRoot: ctx.worktreeRoot,
    basePath: options.basePath ?? config.basePath,
    remote: config.host !== "local",
  });
  log.header();

  try {
    const historyPath = join(CONFIG_DIR, 'history.json');
    if (existsSync(historyPath)) {
      const history: Record<string, number[]> = JSON.parse(readFileSync(historyPath, 'utf-8'));
      const repoDurations = history[options.repo];
      if (repoDurations && repoDurations.length > 0) {
        const avg = repoDurations.reduce((a, b) => a + b, 0) / repoDurations.length;
        log.info(`estimated duration: ${formatTime(avg)} (based on ${repoDurations.length} previous run${repoDurations.length === 1 ? '' : 's'})`);
      }
    }
  } catch { /* ignore */ }

  try {
    await runStep(1, events, stepTimings, () => validate(ctx));

    if (options.dryRun) {
      log.dryRunSummary(ctx.repoPath);
      events.completed({ result: "dry-run", elapsed: Date.now() - ctx.startTime, stepTimings: [...stepTimings] });
      return;
    }

    await runStep(2, events, stepTimings, () => createWorktree(ctx));
    await runStep(3, events, stepTimings, async () => { ctx.mode = await classify(ctx); });
    log.info(`mode: ${ctx.mode}`);
    events.classified(ctx.mode);

    await runStep(4, events, stepTimings, async () => { ctx.plan = await plan(ctx); });

    // Graceful degradation on timeout: if execute times out but partial changes exist, continue
    try {
      await runStep(5, events, stepTimings, () => execute(ctx, events));
    } catch (err) {
      if (err instanceof OneshotError && err.code === 'ERR_TIMEOUT') {
        // Generous timeout for the salvage probe -- git status on a worktree
        // codex was still writing into can be slow, and the default 120s
        // would hide partial-changes signal behind a second ERR_TIMEOUT.
        const probeTimeoutMs = 5 * 60 * 1000;
        const { stdout: diffOut } = await exec(`cd "${ctx.worktreePath}" && git diff --stat`, { timeoutMs: probeTimeoutMs });
        const { stdout: untrackedOut } = await exec(`cd "${ctx.worktreePath}" && git ls-files --others --exclude-standard`, { timeoutMs: probeTimeoutMs });
        if (diffOut.trim() || untrackedOut.trim()) {
          log.warn("execute timed out but partial changes exist, continuing with degraded review");
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }

    // Create draft PR BEFORE review so work is never lost to timeouts
    await runStep(6, events, stepTimings, async () => {
      ctx.prUrl = await createDraftPr(ctx);
      events.agentAction(6, getStepLabel(6), {
        phase: "completed",
        kind: "pr",
        title: "draft PR created",
        ok: true,
        detail: { prUrl: ctx.prUrl },
      });
    });

    // Review pushes fixes on top of the draft PR branch.
    // If review fails or times out, the draft PR still has all the execution work.
    let shouldFinalizePr = false;
    let reviewTimedOut = false;
    try {
      await runStep(7, events, stepTimings, () => review(ctx, events));
      shouldFinalizePr = true;
    } catch (err) {
      if (err instanceof OneshotError && err.code === 'ERR_TIMEOUT') {
        reviewTimedOut = true;
        log.warn("review timed out — salvaging partial changes before finalize");
      } else {
        log.warn(`review failed — draft PR preserved: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Push review fixes (if any) and mark PR as ready. On review timeout we
    // still commit+push whatever codex wrote so the worktree isn't lost, but
    // leave the PR in draft (markReady: false).
    if (shouldFinalizePr) {
      await runStep(8, events, stepTimings, () => finalizeAfterReview(ctx));
    } else if (reviewTimedOut) {
      try {
        await runStep(8, events, stepTimings, () =>
          finalizeAfterReview(ctx, {
            markReady: false,
            commitMessage: "fix: salvage partial review changes (timed out)",
          })
        );
      } catch (salvageErr) {
        log.warn(`salvage after review timeout failed: ${salvageErr instanceof Error ? salvageErr.message : String(salvageErr)}`);
      }
    }

    let filesChanged = 0;
    let diffStats: Array<{ file: string; additions: number; deletions: number }> = [];
    try {
      filesChanged = await getFilesChanged(ctx);
      diffStats = await getDiffStats(ctx);
    } catch { /* non-fatal */ }

    if (options.linearIssueId) {
      try {
        await moveToInReview(ctx.config, options.linearIssueId);
        await addPrComment(ctx.config, options.linearIssueId, ctx.prUrl);
        log.info(`Linear ${options.linearIssueId} moved to In Review`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`failed to update Linear ticket: ${msg}`);
      }
    }

    const totalElapsed = Date.now() - ctx.startTime;
    log.summary(ctx.prUrl, filesChanged, totalElapsed);
    events.completed({ prUrl: ctx.prUrl, filesChanged, elapsed: totalElapsed, diffStats, stepTimings: [...stepTimings] });

    try {
      const historyPath = join(CONFIG_DIR, 'history.json');
      let history: Record<string, number[]> = {};
      if (existsSync(historyPath)) {
        history = JSON.parse(readFileSync(historyPath, 'utf-8'));
      }
      if (!history[options.repo]) history[options.repo] = [];
      history[options.repo].push(totalElapsed);
      if (history[options.repo].length > 20) history[options.repo] = history[options.repo].slice(-20);
      mkdirSync(CONFIG_DIR, { recursive: true });
      const tmpPath = `${historyPath}.${process.pid}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(history, null, 2));
      renameSync(tmpPath, historyPath);
    } catch { /* ignore */ }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const errorCode = err instanceof OneshotError ? err.code : undefined;
    const errorDetail = err instanceof OneshotError ? err.detail : undefined;
    events.failed(msg, Date.now() - ctx.startTime, errorCode, errorDetail, [...stepTimings]);
    log.warn(
      `pipeline failed; preserving worktree for recovery at ${ctx.worktreePath}`
    );
    log.warn(
      `inspect with: ssh <host> 'cd ${ctx.worktreePath} && git log --oneline -5 && git status'`
    );
    throw err;
  } finally {
    // Only clean up the worktree on successful runs (or dry-runs). On failure
    // we keep it on disk so a human can salvage work. createDraftPr also
    // pushes a best-effort snapshot to `oneshot-salvage/<slug>-<runId>` so
    // even without shell access, the commits survive on origin.
    const succeeded = !!ctx.prUrl || options.dryRun;
    if (!options.dryRun && succeeded) {
      try { await removeWorktree(ctx); } catch {
        log.warn(`failed to clean up worktree at ${ctx.worktreePath}`);
      }
    }
  }
};
