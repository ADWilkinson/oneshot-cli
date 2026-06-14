import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { buildNotifyPayload, sendNotification, type NotifyPayload } from "./notify";
import { buildReceipt, type BuildReceiptInput } from "./receipt";

const receipt = buildReceipt({
  runId: "notify-run",
  repo: "acme/widget",
  task: "ship it",
  status: "success",
  prUrl: "https://github.com/acme/widget/pull/9",
  prState: "ready",
  steps: [],
  filesChanged: 1,
  policy: { evaluated: false, ok: true, warnings: [], failures: [] },
  review: { ran: true, mode: "standard", outcome: "passed" },
  assumptions: [],
  elapsedMs: 1000,
} satisfies BuildReceiptInput);

const payload: NotifyPayload = buildNotifyPayload(receipt, "/tmp/notify-run.receipt.json");

describe("buildNotifyPayload", () => {
  test("maps receipt fields", () => {
    expect(payload.runId).toBe("notify-run");
    expect(payload.status).toBe("success");
    expect(payload.prUrl).toBe("https://github.com/acme/widget/pull/9");
    expect(payload.headline).toContain("acme/widget");
  });
});

describe("sendNotification", () => {
  test("no config is a no-op", async () => {
    const result = await sendNotification(undefined, payload);
    expect(result.delivered).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  test("onSuccess:false suppresses success notifications", async () => {
    const result = await sendNotification({ command: "true", onSuccess: false }, payload);
    expect(result.delivered).toEqual([]);
  });

  test("command receives the payload via env", async () => {
    const marker = join(tmpdir(), `oneshot-notify-test-${Date.now()}`);
    const result = await sendNotification(
      { command: `printf '%s' "$ONESHOT_NOTIFY_STATUS:$ONESHOT_NOTIFY_REPO" > ${marker}` },
      payload,
    );
    expect(result.delivered).toContain("command");
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, "utf-8")).toBe("success:acme/widget");
    rmSync(marker, { force: true });
  });

  test("webhook posts JSON", async () => {
    let received: unknown = null;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        received = await req.json();
        return new Response("ok");
      },
    });
    try {
      const result = await sendNotification({ webhook: `http://localhost:${server.port}/hook` }, payload);
      expect(result.delivered).toContain("webhook");
      expect((received as NotifyPayload).repo).toBe("acme/widget");
    } finally {
      server.stop(true);
    }
  });

  test("a failing webhook is captured, not thrown", async () => {
    const result = await sendNotification({ webhook: "http://127.0.0.1:1/nope" }, payload);
    expect(result.delivered).toEqual([]);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain("webhook");
  });
});
