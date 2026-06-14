import type { Receipt } from "./receipt";
import { receiptHeadline } from "./receipt";

/**
 * Fire-and-forget is only useful if you actually find out it finished.
 *
 * The notifier is the wake signal. It is deliberately backend-agnostic: a
 * webhook (POST the payload as JSON) and/or a command (run it with the payload
 * on stdin and in the environment). The package ships neither destination
 * hardcoded -- a user wires Slack, Discord, a desktop toast, or anything else
 * via their own config. Notification is best effort and must never fail a run.
 */

export interface NotifyConfig {
  readonly webhook?: string;
  readonly command?: string;
  readonly onSuccess?: boolean;
  readonly onFailure?: boolean;
}

export interface NotifyPayload {
  readonly runId: string;
  readonly repo: string;
  readonly task: string;
  readonly status: Receipt["status"];
  readonly confidence: Receipt["confidence"];
  readonly prUrl?: string;
  readonly receiptPath?: string;
  readonly headline: string;
  readonly elapsedMs: number;
}

export const buildNotifyPayload = (
  receipt: Receipt,
  receiptPath: string | null,
): NotifyPayload => ({
  runId: receipt.runId,
  repo: receipt.repo,
  task: receipt.task,
  status: receipt.status,
  confidence: receipt.confidence,
  prUrl: receipt.prUrl,
  receiptPath: receiptPath ?? undefined,
  headline: receiptHeadline(receipt),
  elapsedMs: receipt.elapsedMs,
});

const shouldNotify = (config: NotifyConfig, status: Receipt["status"]): boolean => {
  const succeeded = status === "success" || status === "dry-run";
  if (succeeded) return config.onSuccess !== false;
  return config.onFailure !== false;
};

const postWebhook = async (url: string, payload: NotifyPayload): Promise<void> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
};

const runCommand = async (command: string, payload: NotifyPayload): Promise<void> => {
  const json = JSON.stringify(payload);
  const proc = Bun.spawn(["bash", "-c", command], {
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
    env: {
      ...process.env,
      ONESHOT_NOTIFY_JSON: json,
      ONESHOT_NOTIFY_STATUS: payload.status,
      ONESHOT_NOTIFY_REPO: payload.repo,
      ONESHOT_NOTIFY_TASK: payload.task,
      ONESHOT_NOTIFY_HEADLINE: payload.headline,
      ONESHOT_NOTIFY_PR_URL: payload.prUrl ?? "",
      ONESHOT_NOTIFY_RECEIPT: payload.receiptPath ?? "",
      ONESHOT_NOTIFY_RUN_ID: payload.runId,
    },
  });
  proc.stdin.write(json);
  proc.stdin.end();
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      // already exited
    }
  }, 30_000);
  timer.unref();
  try {
    await proc.exited;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Send the notification(s). Never throws: a failed webhook or command is logged
 * by the caller via the returned errors, but the run result stands on its own.
 */
export const sendNotification = async (
  config: NotifyConfig | undefined,
  payload: NotifyPayload,
): Promise<{ delivered: string[]; errors: string[] }> => {
  const delivered: string[] = [];
  const errors: string[] = [];
  if (!config) return { delivered, errors };
  if (!shouldNotify(config, payload.status)) return { delivered, errors };

  if (config.webhook) {
    try {
      await postWebhook(config.webhook, payload);
      delivered.push("webhook");
    } catch (err) {
      errors.push(`webhook: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (config.command) {
    try {
      await runCommand(config.command, payload);
      delivered.push("command");
    } catch (err) {
      errors.push(`command: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { delivered, errors };
};
