import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  buildReceipt,
  deriveConfidence,
  getReceiptFile,
  loadReceipt,
  receiptHeadline,
  renderReceiptHtml,
  renderReceiptText,
  writeReceipt,
  type BuildReceiptInput,
  type ReceiptPolicy,
  type ReceiptReview,
} from "./receipt";

const cleanPolicy: ReceiptPolicy = { evaluated: true, ok: true, warnings: [], failures: [] };
const passedReview: ReceiptReview = { ran: true, mode: "deep", outcome: "passed" };

const baseInput = (overrides: Partial<BuildReceiptInput> = {}): BuildReceiptInput => ({
  runId: "test-run",
  repo: "acme/widget",
  task: "fix the login timeout",
  status: "success",
  prUrl: "https://github.com/acme/widget/pull/1",
  prState: "ready",
  mode: "deep",
  steps: [
    { step: 1, label: "Validating repo", status: "done", elapsedMs: 1000 },
    { step: 5, label: "Executing change", status: "done", elapsedMs: 60000 },
  ],
  filesChanged: 3,
  diffStats: [{ file: "src/a.ts", additions: 10, deletions: 2 }],
  policy: cleanPolicy,
  review: passedReview,
  assumptions: ["base branch defaulted to main"],
  elapsedMs: 65000,
  startedAt: 1000,
  ...overrides,
});

describe("deriveConfidence", () => {
  test("clean success is high", () => {
    expect(deriveConfidence({ status: "success", policy: cleanPolicy, review: passedReview })).toBe("high");
  });

  test("success with policy warning is medium", () => {
    expect(
      deriveConfidence({
        status: "success",
        policy: { evaluated: true, ok: true, warnings: ["approval-sensitive keyword"], failures: [] },
        review: passedReview,
      }),
    ).toBe("medium");
  });

  test("success with timed-out review is medium", () => {
    expect(
      deriveConfidence({
        status: "success",
        policy: cleanPolicy,
        review: { ran: true, mode: "deep", outcome: "timed-out" },
      }),
    ).toBe("medium");
  });

  test("draft is low", () => {
    expect(deriveConfidence({ status: "draft", policy: cleanPolicy, review: passedReview })).toBe("low");
  });

  test("failed is low", () => {
    expect(deriveConfidence({ status: "failed", policy: cleanPolicy, review: passedReview })).toBe("low");
  });
});

describe("buildReceipt", () => {
  test("assigns confidence and copies fields", () => {
    const receipt = buildReceipt(baseInput());
    expect(receipt.schema).toBe(1);
    expect(receipt.confidence).toBe("high");
    expect(receipt.repo).toBe("acme/widget");
    expect(receipt.filesChanged).toBe(3);
    expect(receipt.finishedAt).toBeGreaterThan(0);
  });

  test("truncates a very long plan", () => {
    const longPlan = "x".repeat(9000);
    const receipt = buildReceipt(baseInput({ plan: longPlan }));
    expect(receipt.plan).toBeDefined();
    expect(receipt.plan!.length).toBeLessThan(longPlan.length);
    expect(receipt.plan!.endsWith("(truncated)")).toBe(true);
  });

  test("drops empty pr url", () => {
    const receipt = buildReceipt(baseInput({ prUrl: "" }));
    expect(receipt.prUrl).toBeUndefined();
  });
});

describe("render", () => {
  test("text render includes the load-bearing sections", () => {
    const text = renderReceiptText(buildReceipt(baseInput()));
    expect(text).toContain("oneshot receipt");
    expect(text).toContain("contract");
    expect(text).toContain("review");
    expect(text).toContain("policy");
    expect(text).toContain("assumptions");
  });

  test("html render escapes and includes status", () => {
    const receipt = buildReceipt(baseInput({ task: "fix <script> & co" }));
    const html = renderReceiptHtml(receipt);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("fix &lt;script&gt; &amp; co");
    expect(html).not.toContain("fix <script> & co");
  });

  test("headline is a single descriptive line", () => {
    const headline = receiptHeadline(buildReceipt(baseInput()));
    expect(headline).toContain("acme/widget");
    expect(headline).toContain("confidence:high");
    expect(headline.includes("\n")).toBe(false);
  });
});

describe("reconstruction from events", () => {
  const eventsFile = join(tmpdir(), `oneshot-recon-${Date.now()}.events.jsonl`);
  afterAll(() => {
    if (existsSync(eventsFile)) unlinkSync(eventsFile);
  });

  test("caps a reconstructed success at medium confidence", () => {
    const lines = [
      { type: "started", runId: "recon-1", repo: "acme/widget", task: "do a thing", timestamp: 1000 },
      { type: "step", runId: "recon-1", step: 5, label: "Executing change", status: "done", elapsed: 1000, timestamp: 2000 },
      { type: "completed", runId: "recon-1", result: "success", prUrl: "https://x/pr/1", filesChanged: 1, elapsed: 2000, timestamp: 3000 },
    ];
    writeFileSync(eventsFile, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    const receipt = loadReceipt(eventsFile);
    expect(receipt.status).toBe("success");
    expect(receipt.confidence).toBe("medium");
    expect(receipt.assumptions.join(" ")).toContain("reconstructed");
  });
});

describe("persistence", () => {
  const runId = `test-receipt-${Date.now()}`;
  afterAll(() => {
    const path = getReceiptFile(runId);
    if (existsSync(path)) unlinkSync(path);
  });

  test("writes and reloads a receipt", () => {
    const receipt = buildReceipt(baseInput({ runId }));
    const path = writeReceipt(receipt);
    expect(path).not.toBeNull();
    const loaded = loadReceipt(runId);
    expect(loaded.runId).toBe(runId);
    expect(loaded.confidence).toBe("high");
    expect(loaded.repo).toBe("acme/widget");
  });
});
