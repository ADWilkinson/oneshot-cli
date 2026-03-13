import type { PipelineContext, OneshotConfig, OneshotOptions } from "./config";
import { log } from "./log";
import { EventEmitter } from "./events";
import { acquireRepoLock } from "./lockfile";
import { validate } from "./steps/validate";
import { createWorktree, removeWorktree } from "./steps/worktree";
import { plan } from "./steps/plan";
import { execute } from "./steps/execute";
import { review } from "./steps/review";
import { createPr, getFilesChanged } from "./steps/pr";
import { moveToInReview, addPrComment } from "./linear";

const buildContext = (config: OneshotConfig, options: OneshotOptions): PipelineContext => {
  const home = process.env.HOME ?? "/root";
  const basePath = config.basePath.replace("~", home);
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
  };
};

const runStep = async (
  step: number,
  label: string,
  events: EventEmitter,
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
  } catch (err) {
    const elapsed = Date.now() - start;
    log.stepFail(elapsed);
    events.stepFailed(step, label, elapsed);
    throw err;
  }
};

export const runPipeline = async (config: OneshotConfig, options: OneshotOptions): Promise<void> => {
  const ctx = buildContext(config, options);
  const events = new EventEmitter(options.eventsFile ?? null, ctx.runId);
  const releaseLock = acquireRepoLock(options.repo);

  events.started(options.repo, options.task);
  log.header();

  try {
    await runStep(1, "Validating repo", events, () => validate(ctx));

    if (options.dryRun) {
      log.dryRunSummary(ctx.repoPath);
      events.completed({ elapsed: Date.now() - ctx.startTime });
      return;
    }

    await runStep(2, "Creating worktree", events, () => createWorktree(ctx));
    await runStep(3, "Planning with Claude", events, async () => { ctx.plan = await plan(ctx); });
    await runStep(4, "Executing with Codex", events, () => execute(ctx));
    await runStep(5, "Reviewing with Codex", events, () => review(ctx));

    let filesChanged = 0;
    await runStep(6, "Creating PR", events, async () => {
      ctx.prUrl = await createPr(ctx);
      filesChanged = await getFilesChanged(ctx);
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

    log.summary(ctx.prUrl, filesChanged, Date.now() - ctx.startTime);
    events.completed({ prUrl: ctx.prUrl, filesChanged, elapsed: Date.now() - ctx.startTime });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    events.failed(msg, Date.now() - ctx.startTime);
    throw err;
  } finally {
    releaseLock();
    if (!options.dryRun) {
      try { await removeWorktree(ctx); } catch {
        log.warn(`failed to clean up worktree at ${ctx.worktreePath}`);
      }
    }
  }
};
