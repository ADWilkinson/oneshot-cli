import type { PipelineContext, OneshotConfig, OneshotOptions } from "./config";
import { CONFIG_DIR } from "./config";
import { join } from "path";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { log } from "./log";
import { formatTime } from "./log";
import { EventWriter } from "./events";
import { OneshotError, exec } from "./exec";
import { validate } from "./steps/validate";
import { createWorktree, removeWorktree } from "./steps/worktree";
import { classify } from "./steps/classify";
import { plan } from "./steps/plan";
import { execute } from "./steps/execute";
import { review } from "./steps/review";
import { createPr, getFilesChanged, getDiffStats } from "./steps/pr";
import { moveToInReview, addPrComment } from "./linear";

const buildContext = (config: OneshotConfig, options: OneshotOptions): PipelineContext => {
  const home = process.env.HOME ?? "/root";
  const basePath = config.basePath.startsWith("~/")
    ? join(home, config.basePath.slice(2))
    : config.basePath === "~"
      ? home
      : config.basePath;
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return {
    config,
    options,
    runId: id,
    repoPath: `${basePath}/${options.repo}`,
    worktreePath: `/tmp/oneshot-${id}`,
    plan: "",
    prUrl: "",
    startTime: Date.now(),
    mode: 'deep',
  };
};

const stepTimings: Array<{ step: number; label: string; elapsed: number }> = [];

const runStep = async (
  step: number,
  label: string,
  events: EventWriter,
  fn: () => Promise<void>,
): Promise<void> => {
  log.stepStart(step, label);
  events.stepRunning(step, label);
  const start = Date.now();
  try {
    await fn();
    const elapsed = Date.now() - start;
    log.stepDone(elapsed);
    events.stepDone(step, label, elapsed);
    stepTimings.push({ step, label, elapsed });
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

  // Clear step timings for this run
  stepTimings.length = 0;

  events.started(options.repo, options.task);
  log.header();

  // Duration estimation from history
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
    await runStep(1, "Validating repo", events, () => validate(ctx));

    if (options.dryRun) {
      log.dryRunSummary(ctx.repoPath);
      events.completed({ elapsed: Date.now() - ctx.startTime });
      return;
    }

    await runStep(2, "Creating worktree", events, () => createWorktree(ctx));
    await runStep(3, "Classifying task", events, async () => { ctx.mode = await classify(ctx); });
    log.info(`mode: ${ctx.mode}`);
    events.classified(ctx.mode);

    await runStep(4, "Planning with Claude", events, async () => { ctx.plan = await plan(ctx); });

    // Graceful degradation on timeout: if execute times out but partial changes exist, continue
    try {
      await runStep(5, "Executing with Codex", events, () => execute(ctx));
    } catch (err) {
      if (err instanceof OneshotError && err.code === 'ERR_TIMEOUT') {
        const { stdout: diffOut } = await exec(`cd "${ctx.worktreePath}" && git diff --stat`);
        const { stdout: untrackedOut } = await exec(`cd "${ctx.worktreePath}" && git ls-files --others --exclude-standard`);
        if (diffOut.trim() || untrackedOut.trim()) {
          log.warn("execute timed out but partial changes exist, continuing with degraded review");
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }

    await runStep(6, "Reviewing with Codex", events, () => review(ctx));

    let filesChanged = 0;
    let diffStats: Array<{ file: string; additions: number; deletions: number }> = [];
    await runStep(7, "Creating PR", events, async () => {
      ctx.prUrl = await createPr(ctx);
      filesChanged = await getFilesChanged(ctx);
      diffStats = await getDiffStats(ctx);
    });

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

    // Record duration to history
    try {
      const historyPath = join(CONFIG_DIR, 'history.json');
      let history: Record<string, number[]> = {};
      if (existsSync(historyPath)) {
        history = JSON.parse(readFileSync(historyPath, 'utf-8'));
      }
      if (!history[options.repo]) history[options.repo] = [];
      history[options.repo].push(totalElapsed);
      // Keep last 20 runs per repo
      if (history[options.repo].length > 20) history[options.repo] = history[options.repo].slice(-20);
      writeFileSync(historyPath, JSON.stringify(history, null, 2));
    } catch { /* ignore */ }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const errorCode = err instanceof OneshotError ? err.code : undefined;
    const errorDetail = err instanceof OneshotError ? err.detail : undefined;
    events.failed(msg, Date.now() - ctx.startTime, errorCode, errorDetail);
    throw err;
  } finally {
    if (!options.dryRun) {
      try { await removeWorktree(ctx); } catch {
        log.warn(`failed to clean up worktree at ${ctx.worktreePath}`);
      }
    }
  }
};
