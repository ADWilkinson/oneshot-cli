import type { PipelineContext, OneshotConfig, OneshotOptions } from "./config";
import { CONFIG_DIR } from "./config";
import { join } from "path";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { hostname } from "os";
import { createHash } from "crypto";
import { log } from "./log";
import { formatTime } from "./log";
import { EventWriter } from "./events";
import { OneshotError, exec, execOrThrow } from "./exec";
import { VERSION } from "./version";
import { expandHome } from "./path-utils";
import { resolveRepoPath } from "./repo";
import { shellEscape } from "./shell";
import { validate } from "./steps/validate";
import { createWorktree, removeWorktree } from "./steps/worktree";
import { classify } from "./steps/classify";
import { renderRouteDecision, routeTask } from "./routing";
import { plan } from "./steps/plan";
import { execute } from "./steps/execute";
import { review } from "./steps/review";
import { createDraftPr, finalizeAfterReview, getFilesChanged, getDiffStats } from "./steps/pr";
import { moveToInReview, addPrComment } from "./linear";
import { getStepLabel } from "./pipeline-steps";
import { validatePolicy } from "./policy";
import type { PolicyValidationResult } from "./policy";
import { buildReceipt, writeReceipt } from "./receipt";
import type { ReceiptReview, ReceiptStatus, ReceiptStep } from "./receipt";
import { buildNotifyPayload, sendNotification } from "./notify";

const buildContext = (config: OneshotConfig, options: OneshotOptions): PipelineContext => {
  const basePath = expandHome(options.basePath ?? config.basePath);
  const worktreeRoot = expandHome(options.worktreeRoot ?? config.worktreeRoot ?? "/tmp");
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return {
    config,
    options,
    runId: id,
    repoPath: resolveRepoPath(basePath, options.repo),
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

interface SourceCheckoutSnapshot {
  path: string;
  branch: string;
  head: string;
  status: string;
  fingerprint: string;
}

const getSourceCheckoutFingerprint = async (repoPath: string): Promise<string> => {
  const diff = await execOrThrow(`cd ${shellEscape(repoPath)} && git diff --binary`);
  const stagedDiff = await execOrThrow(`cd ${shellEscape(repoPath)} && git diff --cached --binary`);
  const untracked = await execOrThrow(
    `cd ${shellEscape(repoPath)} && git ls-files --others --exclude-standard -z | while IFS= read -r -d '' path; do printf '%s\\0' "$path"; git hash-object -- "$path"; printf '\\0'; done`
  );
  return createHash("sha256")
    .update(diff)
    .update("\0")
    .update(stagedDiff)
    .update("\0")
    .update(untracked)
    .digest("hex");
};

const getSourceCheckoutSnapshot = async (repoPath: string): Promise<SourceCheckoutSnapshot> => {
  const branch = await execOrThrow(`cd ${shellEscape(repoPath)} && git rev-parse --abbrev-ref HEAD`);
  const head = await execOrThrow(`cd ${shellEscape(repoPath)} && git rev-parse HEAD`);
  const status = await execOrThrow(`cd ${shellEscape(repoPath)} && git status --porcelain=v1`);
  const fingerprint = await getSourceCheckoutFingerprint(repoPath);
  return {
    path: repoPath,
    branch: branch.trim(),
    head: head.trim(),
    status: status.replace(/\n$/, ""),
    fingerprint,
  };
};

const formatSourceCheckoutStatus = (status: string): string => {
  if (!status) return "clean";
  return `dirty(${status.split("\n").slice(0, 5).join(", ")})`;
};

const formatSourceCheckoutSnapshot = (snapshot: SourceCheckoutSnapshot): string =>
  `${snapshot.branch}@${snapshot.head} ${formatSourceCheckoutStatus(snapshot.status)} ${snapshot.fingerprint.slice(0, 12)}`;

const verifySourceCheckoutUnchanged = async (
  before: SourceCheckoutSnapshot,
  originalError?: unknown,
): Promise<void> => {
  const after = await getSourceCheckoutSnapshot(before.path);
  if (
    after.branch === before.branch &&
    after.head === before.head &&
    after.status === before.status &&
    after.fingerprint === before.fingerprint
  ) return;

  const detail = originalError == null
    ? undefined
    : `Original error: ${originalError instanceof Error ? originalError.message : String(originalError)}`;
  throw new OneshotError(
    `source checkout mutated at ${before.path}: before ${formatSourceCheckoutSnapshot(before)}, after ${formatSourceCheckoutSnapshot(after)}`,
    "ERR_SOURCE_CHECKOUT_MUTATED",
    detail,
  );
};

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
  let sourceCheckout: SourceCheckoutSnapshot | undefined;
  let failed = false;
  const verifySourceCheckout = async (): Promise<void> => {
    if (sourceCheckout) await verifySourceCheckoutUnchanged(sourceCheckout);
  };

  // Receipt + notification state, accumulated through the run so the proof-of-work
  // object can be built whether the pipeline succeeds, drafts, or fails.
  let policyResult: PolicyValidationResult | undefined;
  let reviewAttempted = false;
  let reviewMode: "standard" | "deep" = "standard";
  let reviewOutcome: ReceiptReview["outcome"] = "skipped";
  let prState: "ready" | "draft" | undefined;
  const assumptions: string[] = [];

  const emitReceipt = async (
    status: ReceiptStatus,
    extra: {
      filesChanged?: number;
      diffStats?: Array<{ file: string; additions: number; deletions: number }>;
      error?: string;
      errorCode?: string;
    } = {},
  ): Promise<void> => {
    const steps: ReceiptStep[] = stepTimings.map((timing) => ({
      step: timing.step,
      label: timing.label,
      status: "done",
      elapsedMs: timing.elapsed,
    }));
    const review: ReceiptReview = {
      ran: reviewAttempted,
      mode: reviewAttempted ? reviewMode : "skipped",
      outcome: reviewOutcome,
    };
    const policy = policyResult
      ? {
          evaluated: policyResult.evaluated,
          ok: policyResult.ok,
          warnings: policyResult.warnings,
          failures: policyResult.failures,
        }
      : { evaluated: false, ok: status !== "failed", warnings: [], failures: [] };

    const receipt = buildReceipt({
      runId: ctx.runId,
      repo: options.repo,
      task: options.taskSummary ?? options.task,
      status,
      prUrl: ctx.prUrl,
      prState,
      mode: ctx.mode,
      route: ctx.route ? renderRouteDecision(ctx.route) : undefined,
      plan: ctx.plan,
      steps,
      filesChanged: extra.filesChanged ?? 0,
      diffStats: extra.diffStats,
      policy,
      review,
      assumptions,
      error: extra.error,
      errorCode: extra.errorCode,
      elapsedMs: Date.now() - ctx.startTime,
      startedAt: ctx.startTime,
      host: hostname(),
    });

    const receiptPath = writeReceipt(receipt);
    if (receiptPath) log.info(`receipt: ${receiptPath}`);
    try {
      const { delivered, errors } = await sendNotification(
        config.notify,
        buildNotifyPayload(receipt, receiptPath),
      );
      for (const err of errors) log.warn(`notify ${err}`);
      if (delivered.length) log.info(`notified via ${delivered.join(", ")}`);
    } catch {
      // A failed notification must never change the run's outcome.
    }
  };

  events.started(options.repo, options.task, undefined, {
      cliVersion: VERSION,
      host: hostname(),
      pid: process.pid,
      cwd: process.cwd(),
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
      await emitReceipt("dry-run");
      return;
    }

    sourceCheckout = await getSourceCheckoutSnapshot(ctx.repoPath);

    await runStep(2, events, stepTimings, () => createWorktree(ctx));
    await runStep(3, events, stepTimings, async () => {
      ctx.route = routeTask(options.task, {
        defaultProvider: config.provider,
        routingEnabled: config.routing?.enabled,
        modeOverride: options.mode,
      });
      ctx.mode = ctx.route.mode;
      if (!options.mode) ctx.mode = await classify(ctx);
    });
    const route = ctx.route;
    if (!route) throw new OneshotError("task routing did not produce a route decision", "ERR_UNKNOWN");
    log.info(`route: ${renderRouteDecision(route)}`);
    log.info(`route reason: ${route.reason}`);
    events.classified(ctx.mode);

    // Record the defaults a detached run applied without confirming with the
    // operator, so the receipt can surface them for audit.
    if (!options.branch) assumptions.push("base branch defaulted to main");
    assumptions.push(
      options.mode
        ? `review mode forced to ${ctx.mode}`
        : `review mode auto-classified as ${ctx.mode}`,
    );
    if (options.workflow) assumptions.push(`workflow preset applied: ${options.workflow}`);
    reviewMode = options.deepReview || ctx.mode === "deep" ? "deep" : "standard";

    await runStep(4, events, stepTimings, async () => { ctx.plan = await plan(ctx); });
    await verifySourceCheckout();

    // Graceful degradation on timeout: if execute times out but partial changes exist, continue
    try {
      await runStep(5, events, stepTimings, () => execute(ctx, events));
    } catch (err) {
      if (err instanceof OneshotError && err.code === 'ERR_TIMEOUT') {
        // Generous timeout for the salvage probe -- git status on a worktree
        // an agent was still writing into can be slow, and the default 120s
        // would hide partial-changes signal behind a second ERR_TIMEOUT.
        const probeTimeoutMs = 5 * 60 * 1000;
        const { stdout: diffOut } = await exec(`cd ${shellEscape(ctx.worktreePath)} && git diff --stat`, { timeoutMs: probeTimeoutMs });
        const { stdout: untrackedOut } = await exec(`cd ${shellEscape(ctx.worktreePath)} && git ls-files --others --exclude-standard`, { timeoutMs: probeTimeoutMs });
        if (diffOut.trim() || untrackedOut.trim()) {
          log.warn("execute timed out but partial changes exist, continuing with degraded review");
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }
    await verifySourceCheckout();

    const policy = await validatePolicy(ctx);
    policyResult = policy;
    for (const warning of policy.warnings) {
      log.warn(`policy: ${warning}`);
      events.agentAction(5, getStepLabel(5), {
        phase: "completed",
        kind: "warning",
        title: warning,
        ok: true,
      });
    }
    if (!policy.ok) {
      throw new OneshotError(`policy gate failed: ${policy.failures.join("; ")}`, "ERR_UNKNOWN");
    }

    // Create draft PR BEFORE review so work is never lost to timeouts
    await runStep(6, events, stepTimings, async () => {
      ctx.prUrl = await createDraftPr(ctx, { verifySourceCheckout });
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
    reviewAttempted = true;
    try {
      await runStep(7, events, stepTimings, () => review(ctx, events));
      shouldFinalizePr = true;
      reviewOutcome = "passed";
    } catch (err) {
      if (err instanceof OneshotError && err.code === 'ERR_TIMEOUT') {
        reviewTimedOut = true;
        reviewOutcome = "timed-out";
        log.warn("review timed out — salvaging partial changes before finalize");
      } else {
        reviewOutcome = "failed";
        log.warn(`review failed — draft PR preserved: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await verifySourceCheckout();

    // Push review fixes (if any) and mark PR as ready. On review timeout we
    // still commit+push whatever the agent wrote so the worktree isn't lost, but
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

    await verifySourceCheckout();

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

    let filesChanged = 0;
    let diffStats: Array<{ file: string; additions: number; deletions: number }> = [];
    try {
      filesChanged = await getFilesChanged(ctx);
      diffStats = await getDiffStats(ctx);
    } catch { /* non-fatal */ }

    const totalElapsed = Date.now() - ctx.startTime;
    log.summary(ctx.prUrl, filesChanged, totalElapsed);
    events.completed({ prUrl: ctx.prUrl, filesChanged, elapsed: totalElapsed, diffStats, stepTimings: [...stepTimings] });

    // A run that reached finalize-and-mark-ready is a shipped success; a run
    // whose review failed or timed out leaves the PR as a draft to be inspected.
    prState = shouldFinalizePr ? "ready" : "draft";
    const receiptStatus: ReceiptStatus = shouldFinalizePr ? "success" : "draft";
    await emitReceipt(receiptStatus, { filesChanged, diffStats });

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
    failed = true;
    let finalErr = err;
    if (sourceCheckout) {
      try {
        await verifySourceCheckoutUnchanged(sourceCheckout, err);
      } catch (sourceErr) {
        finalErr = sourceErr;
      }
    }
    const msg = finalErr instanceof Error ? finalErr.message : String(finalErr);
    const errorCode = finalErr instanceof OneshotError ? finalErr.code : undefined;
    const errorDetail = finalErr instanceof OneshotError ? finalErr.detail : undefined;
    events.failed(msg, Date.now() - ctx.startTime, errorCode, errorDetail, [...stepTimings]);
    await emitReceipt("failed", { error: msg, errorCode });
    log.warn(
      `pipeline failed; preserving worktree for recovery at ${ctx.worktreePath}`
    );
    log.warn(
      `inspect with: ssh <host> 'cd ${ctx.worktreePath} && git log --oneline -5 && git status'`
    );
    throw finalErr;
  } finally {
    // Only clean up the worktree on successful runs (or dry-runs). On failure
    // we keep it on disk so a human can salvage work. createDraftPr also
    // pushes a best-effort snapshot to `oneshot-salvage/<slug>-<runId>` so
    // even without shell access, the commits survive on origin.
    const succeeded = !failed && (!!ctx.prUrl || options.dryRun);
    if (!options.dryRun && succeeded) {
      try { await removeWorktree(ctx); } catch {
        log.warn(`failed to clean up worktree at ${ctx.worktreePath}`);
      }
    }
  }
};
