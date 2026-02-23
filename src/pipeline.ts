import type { PipelineContext, OneshotConfig, OneshotOptions } from "./config";
import { log } from "./log";
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
    repoPath: `${basePath}/${options.repo}`,
    worktreePath: `/tmp/oneshot-${id}`,
    plan: "",
    prUrl: "",
    startTime: Date.now(),
  };
};

const runStep = async (step: number, label: string, fn: () => Promise<void>): Promise<void> => {
  log.stepStart(step, label);
  const start = Date.now();
  try {
    await fn();
    log.stepDone(Date.now() - start);
  } catch (err) {
    log.stepFail(Date.now() - start);
    throw err;
  }
};

export const runPipeline = async (config: OneshotConfig, options: OneshotOptions): Promise<void> => {
  const ctx = buildContext(config, options);

  log.header();

  try {
    await runStep(1, "Validating repo", () => validate(ctx));

    if (options.dryRun) {
      log.dryRunSummary(ctx.repoPath);
      return;
    }

    await runStep(2, "Creating worktree", () => createWorktree(ctx));
    await runStep(3, "Planning with Claude", async () => { ctx.plan = await plan(ctx); });
    await runStep(4, "Executing with Codex", () => execute(ctx));
    await runStep(5, "Reviewing with Codex", () => review(ctx));

    let filesChanged = 0;
    await runStep(6, "Creating PR", async () => {
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
  } finally {
    if (!options.dryRun) {
      try { await removeWorktree(ctx); } catch {
        log.warn(`failed to clean up worktree at ${ctx.worktreePath}`);
      }
    }
  }
};
