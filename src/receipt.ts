import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { RUNS_DIR, snapshotFromEvents, resolveRunEventsFile } from "./runs";
import { VERSION } from "./version";

/**
 * The receipt is oneshot's proof-of-work object.
 *
 * A detached run you fired and forgot is only trustworthy if you can audit, in
 * one screen, that the quality contract actually ran: what was planned, what the
 * review found, whether the policy gate held, which defaults the run had to
 * assume because it could not ask you, and how confident the result is. The
 * receipt is that screen. It is written for every run (success or failure) so
 * the guarantee is something you can inspect after the fact, not a claim.
 */

export type ReceiptStatus =
  | "success"
  | "draft"
  | "failed"
  | "dry-run"
  | "running"
  | "unknown";

export type ReceiptConfidence = "high" | "medium" | "low";

export interface ReceiptStep {
  readonly step: number;
  readonly label: string;
  readonly status: string;
  readonly elapsedMs?: number;
}

export interface ReceiptReview {
  readonly ran: boolean;
  readonly mode: "standard" | "deep" | "skipped";
  readonly outcome: "passed" | "timed-out" | "failed" | "skipped";
}

export interface ReceiptPolicy {
  readonly evaluated: boolean;
  readonly ok: boolean;
  readonly warnings: string[];
  readonly failures: string[];
}

export interface Receipt {
  readonly schema: 1;
  readonly runId: string;
  readonly repo: string;
  readonly task: string;
  readonly status: ReceiptStatus;
  readonly confidence: ReceiptConfidence;
  readonly prUrl?: string;
  readonly prState?: "ready" | "draft";
  readonly mode?: string;
  readonly route?: string;
  readonly plan?: string;
  readonly steps: ReceiptStep[];
  readonly filesChanged: number;
  readonly diffStats: Array<{ file: string; additions: number; deletions: number }>;
  readonly policy: ReceiptPolicy;
  readonly review: ReceiptReview;
  readonly assumptions: string[];
  readonly error?: string;
  readonly errorCode?: string;
  readonly elapsedMs: number;
  readonly startedAt?: number;
  readonly finishedAt: number;
  readonly host?: string;
  readonly cliVersion: string;
}

export interface BuildReceiptInput {
  runId: string;
  repo: string;
  task: string;
  status: ReceiptStatus;
  prUrl?: string;
  prState?: "ready" | "draft";
  mode?: string;
  route?: string;
  plan?: string;
  steps: ReceiptStep[];
  filesChanged: number;
  diffStats?: Array<{ file: string; additions: number; deletions: number }>;
  policy: ReceiptPolicy;
  review: ReceiptReview;
  assumptions: string[];
  error?: string;
  errorCode?: string;
  elapsedMs: number;
  startedAt?: number;
  host?: string;
}

export const getReceiptFile = (runId: string): string =>
  join(RUNS_DIR, `${runId}.receipt.json`);

/**
 * Confidence reflects how much of the contract held without compromise.
 * - high:   shipped, review passed, policy clean (no failures, no warnings)
 * - medium: shipped but with a caveat (review timed out, or policy warned)
 * - low:    left as a draft, or failed outright
 */
export const deriveConfidence = (input: {
  status: ReceiptStatus;
  policy: ReceiptPolicy;
  review: ReceiptReview;
}): ReceiptConfidence => {
  const { status, policy, review } = input;
  if (status === "failed") return "low";
  if (status === "draft") return "low";
  if (status === "dry-run") return "medium";
  if (status === "running" || status === "unknown") return "low";

  // status === "success"
  const reviewClean = review.outcome === "passed" || review.outcome === "skipped";
  const policyClean = policy.ok && policy.warnings.length === 0;
  if (reviewClean && policyClean) return "high";
  return "medium";
};

const truncatePlan = (plan: string | undefined, max = 4000): string | undefined => {
  if (!plan) return undefined;
  const trimmed = plan.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}\n... (truncated)`;
};

export const buildReceipt = (input: BuildReceiptInput): Receipt => {
  const confidence = deriveConfidence({
    status: input.status,
    policy: input.policy,
    review: input.review,
  });
  return {
    schema: 1,
    runId: input.runId,
    repo: input.repo,
    task: input.task,
    status: input.status,
    confidence,
    prUrl: input.prUrl || undefined,
    prState: input.prState,
    mode: input.mode,
    route: input.route,
    plan: truncatePlan(input.plan),
    steps: input.steps,
    filesChanged: input.filesChanged,
    diffStats: input.diffStats ?? [],
    policy: input.policy,
    review: input.review,
    assumptions: input.assumptions,
    error: input.error,
    errorCode: input.errorCode,
    elapsedMs: input.elapsedMs,
    startedAt: input.startedAt,
    finishedAt: Date.now(),
    host: input.host,
    cliVersion: VERSION,
  };
};

/** Persist a receipt to the durable ledger. Best effort: never throws. */
export const writeReceipt = (receipt: Receipt): string | null => {
  try {
    mkdirSync(RUNS_DIR, { recursive: true });
    const path = getReceiptFile(receipt.runId);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(receipt, null, 2) + "\n");
    renameSync(tmp, path);
    return path;
  } catch {
    return null;
  }
};

/**
 * Load a receipt for a run. Prefers the authoritative receipt.json written by
 * the pipeline (it has in-memory detail events cannot carry, like the plan and
 * the policy verdict). Falls back to reconstructing a thinner receipt from the
 * event stream so older runs and remote runs still produce something useful.
 */
export const loadReceipt = (runIdOrPath: string): Receipt => {
  if (!runIdOrPath.includes("/")) {
    const path = getReceiptFile(runIdOrPath);
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, "utf-8")) as Receipt;
      } catch {
        // fall through to event reconstruction
      }
    }
  }
  return reconstructReceiptFromEvents(runIdOrPath);
};

const reconstructReceiptFromEvents = (runIdOrPath: string): Receipt => {
  const eventsFile = resolveRunEventsFile(runIdOrPath);
  const snapshot = snapshotFromEvents(eventsFile, 25);
  const status: ReceiptStatus =
    snapshot.status === "success"
      ? "success"
      : snapshot.status === "failed"
        ? "failed"
        : snapshot.status === "dry-run"
          ? "dry-run"
          : snapshot.status === "running"
            ? "running"
            : "unknown";
  const policy: ReceiptPolicy = { evaluated: false, ok: status !== "failed", warnings: [], failures: [] };
  const review: ReceiptReview = {
    ran: status === "success",
    mode: "skipped",
    outcome: status === "success" ? "passed" : "skipped",
  };
  // A reconstruction only sees the event stream, not the policy or review
  // verdict, so it cannot honestly claim "high". Cap a reconstructed success at
  // "medium"; the authoritative receipt.json is the source of a high rating.
  const derived = deriveConfidence({ status, policy, review });
  const confidence = derived === "high" ? "medium" : derived;
  return {
    schema: 1,
    runId: snapshot.runId,
    repo: snapshot.repo,
    task: snapshot.task,
    status,
    confidence,
    prUrl: snapshot.prUrl,
    prState: snapshot.prUrl ? "ready" : undefined,
    mode: undefined,
    route: undefined,
    plan: undefined,
    steps: snapshot.currentStep
      ? [{ step: snapshot.currentStep.step, label: snapshot.currentStep.label, status: snapshot.currentStep.status }]
      : [],
    filesChanged: snapshot.filesChanged ?? snapshot.changedFiles.length,
    diffStats: [],
    policy,
    review,
    assumptions: ["reconstructed from event stream; receipt.json not available"],
    error: snapshot.error,
    elapsedMs: snapshot.elapsed ?? 0,
    startedAt: snapshot.startedAt,
    finishedAt: snapshot.updatedAt,
    host: typeof snapshot.runtime?.host === "string" ? snapshot.runtime.host : undefined,
    cliVersion:
      typeof snapshot.runtime?.cliVersion === "string" ? snapshot.runtime.cliVersion : VERSION,
  };
};

const formatMs = (ms: number): string => {
  if (!ms) return "-";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

const statusGlyph = (status: ReceiptStatus): string => {
  if (status === "success") return "shipped";
  if (status === "draft") return "draft (review incomplete)";
  if (status === "failed") return "failed";
  if (status === "dry-run") return "dry-run";
  return status;
};

/** One-line summary suitable for a notification or a list row. */
export const receiptHeadline = (receipt: Receipt): string => {
  const bits = [
    statusGlyph(receipt.status),
    receipt.repo,
    `${receipt.filesChanged} file${receipt.filesChanged === 1 ? "" : "s"}`,
    formatMs(receipt.elapsedMs),
    `confidence:${receipt.confidence}`,
  ];
  return bits.join(" | ");
};

export const renderReceiptText = (receipt: Receipt): string => {
  const lines: string[] = [];
  lines.push(`oneshot receipt  ${receipt.runId}`);
  lines.push(`status      ${statusGlyph(receipt.status)}  (confidence: ${receipt.confidence})`);
  lines.push(`repo        ${receipt.repo}`);
  lines.push(`task        ${receipt.task}`);
  if (receipt.mode) lines.push(`mode        ${receipt.mode}`);
  if (receipt.route) lines.push(`route       ${receipt.route}`);
  lines.push(`time        ${formatMs(receipt.elapsedMs)}`);
  lines.push(`files       ${receipt.filesChanged}`);
  if (receipt.prUrl) lines.push(`pr          ${receipt.prUrl}${receipt.prState ? ` (${receipt.prState})` : ""}`);
  if (receipt.error) lines.push(`error       ${receipt.error}`);

  lines.push("");
  lines.push("contract");
  for (const step of receipt.steps) {
    const mark = step.status === "done" ? "ok" : step.status === "failed" ? "fail" : step.status;
    lines.push(`  [${mark}] ${step.label}${step.elapsedMs ? `  ${formatMs(step.elapsedMs)}` : ""}`);
  }

  lines.push("");
  lines.push("review");
  lines.push(`  ${receipt.review.ran ? receipt.review.mode : "not run"} -> ${receipt.review.outcome}`);

  lines.push("");
  lines.push("policy");
  if (!receipt.policy.evaluated) {
    lines.push("  no .oneshot/policy.json (not evaluated)");
  } else {
    lines.push(`  gate ${receipt.policy.ok ? "passed" : "FAILED"}`);
    for (const w of receipt.policy.warnings) lines.push(`  warn: ${w}`);
    for (const f of receipt.policy.failures) lines.push(`  fail: ${f}`);
  }

  if (receipt.assumptions.length > 0) {
    lines.push("");
    lines.push("assumptions (defaults the run could not confirm with you)");
    for (const a of receipt.assumptions) lines.push(`  - ${a}`);
  }

  if (receipt.diffStats.length > 0) {
    lines.push("");
    lines.push("diff");
    for (const stat of receipt.diffStats.slice(0, 20)) {
      lines.push(`  ${stat.file}  +${stat.additions} -${stat.deletions}`);
    }
    if (receipt.diffStats.length > 20) lines.push(`  ... ${receipt.diffStats.length - 20} more`);
  }

  if (receipt.plan) {
    lines.push("");
    lines.push("plan");
    for (const line of receipt.plan.split("\n")) lines.push(`  ${line}`);
  }

  return lines.join("\n");
};

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export const renderReceiptHtml = (receipt: Receipt): string => {
  const accent =
    receipt.status === "success" ? "#16a34a" : receipt.status === "failed" ? "#dc2626" : "#d97706";
  const confidenceColor =
    receipt.confidence === "high" ? "#16a34a" : receipt.confidence === "medium" ? "#d97706" : "#dc2626";

  const steps = receipt.steps
    .map((step) => {
      const ok = step.status === "done";
      const failed = step.status === "failed";
      const color = ok ? "#16a34a" : failed ? "#dc2626" : "#6b7280";
      const glyph = ok ? "&#10003;" : failed ? "&#10007;" : "&#8226;";
      return `<li><span style="color:${color};font-weight:600">${glyph}</span> ${escapeHtml(step.label)}<span class="dim">${step.elapsedMs ? ` ${formatMs(step.elapsedMs)}` : ""}</span></li>`;
    })
    .join("");

  const policyBlock = !receipt.policy.evaluated
    ? `<p class="dim">No <code>.oneshot/policy.json</code> in this repo, so the policy gate was not evaluated.</p>`
    : `<p><strong style="color:${receipt.policy.ok ? "#16a34a" : "#dc2626"}">gate ${receipt.policy.ok ? "passed" : "FAILED"}</strong></p>` +
      receipt.policy.failures.map((f) => `<div class="bad">fail: ${escapeHtml(f)}</div>`).join("") +
      receipt.policy.warnings.map((w) => `<div class="warn">warn: ${escapeHtml(w)}</div>`).join("");

  const assumptions = receipt.assumptions.length
    ? `<section><h2>Assumptions</h2><p class="dim">Defaults the run applied because a detached run cannot ask you.</p><ul>${receipt.assumptions
        .map((a) => `<li>${escapeHtml(a)}</li>`)
        .join("")}</ul></section>`
    : "";

  const diff = receipt.diffStats.length
    ? `<section><h2>Diff</h2><table>${receipt.diffStats
        .map(
          (s) =>
            `<tr><td class="mono">${escapeHtml(s.file)}</td><td class="add">+${s.additions}</td><td class="del">-${s.deletions}</td></tr>`,
        )
        .join("")}</table></section>`
    : "";

  const plan = receipt.plan
    ? `<section><h2>Plan</h2><pre>${escapeHtml(receipt.plan)}</pre></section>`
    : "";

  const pr = receipt.prUrl
    ? `<a class="pr" href="${escapeHtml(receipt.prUrl)}">${escapeHtml(receipt.prUrl)}${receipt.prState ? ` (${receipt.prState})` : ""}</a>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>oneshot receipt ${escapeHtml(receipt.runId)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; max-width: 820px; margin: 0 auto; padding: 32px 20px; color: #111; background: #fafafa; }
  @media (prefers-color-scheme: dark) { body { color: #e5e5e5; background: #0c0c0c; } table, pre, code { background: #161616 !important; } .card { background: #161616; border-color: #262626; } }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: #6b7280; margin: 28px 0 8px; }
  .card { border: 1px solid #e5e5e5; border-radius: 12px; padding: 20px; background: #fff; border-left: 4px solid ${accent}; }
  .meta { display: grid; grid-template-columns: 96px 1fr; gap: 4px 12px; margin-top: 12px; font-size: 14px; }
  .meta dt { color: #6b7280; }
  .meta dd { margin: 0; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 700; color: #fff; background: ${accent}; }
  .conf { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 700; color: #fff; background: ${confidenceColor}; margin-left: 6px; }
  ul { margin: 6px 0; padding-left: 18px; }
  li { margin: 3px 0; list-style: none; margin-left: -14px; }
  .dim { color: #9ca3af; }
  .mono, pre, code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  pre { background: #f3f4f6; padding: 14px; border-radius: 8px; overflow: auto; font-size: 13px; white-space: pre-wrap; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  td { padding: 3px 8px; border-bottom: 1px solid #ececec; }
  .add { color: #16a34a; text-align: right; width: 64px; }
  .del { color: #dc2626; text-align: right; width: 64px; }
  .bad { color: #dc2626; }
  .warn { color: #d97706; }
  .pr { display: inline-block; margin-top: 6px; word-break: break-all; }
  footer { margin-top: 28px; color: #9ca3af; font-size: 12px; }
</style>
</head>
<body>
  <div class="card">
    <h1>oneshot receipt</h1>
    <div><span class="badge">${escapeHtml(statusGlyph(receipt.status))}</span><span class="conf">confidence: ${receipt.confidence}</span></div>
    <dl class="meta">
      <dt>repo</dt><dd>${escapeHtml(receipt.repo)}</dd>
      <dt>task</dt><dd>${escapeHtml(receipt.task)}</dd>
      ${receipt.mode ? `<dt>mode</dt><dd>${escapeHtml(receipt.mode)}</dd>` : ""}
      <dt>time</dt><dd>${formatMs(receipt.elapsedMs)}</dd>
      <dt>files</dt><dd>${receipt.filesChanged}</dd>
      ${receipt.prUrl ? `<dt>pr</dt><dd>${pr}</dd>` : ""}
      ${receipt.error ? `<dt>error</dt><dd class="bad">${escapeHtml(receipt.error)}</dd>` : ""}
    </dl>
  </div>

  <section><h2>Contract</h2><ul>${steps}</ul></section>
  <section><h2>Review</h2><p>${receipt.review.ran ? escapeHtml(receipt.review.mode) : "not run"} &rarr; <strong>${escapeHtml(receipt.review.outcome)}</strong></p></section>
  <section><h2>Policy</h2>${policyBlock}</section>
  ${assumptions}
  ${diff}
  ${plan}
  <footer>oneshot v${escapeHtml(receipt.cliVersion)} &middot; run ${escapeHtml(receipt.runId)} &middot; ${receipt.host ? escapeHtml(receipt.host) : "local"}</footer>
</body>
</html>
`;
};
