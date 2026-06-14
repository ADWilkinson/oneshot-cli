import { loadLocalConfig, type OneshotOptions } from "./config";
import { runPipeline } from "./pipeline";
import { initPolicy } from "./policy";
import { listRunSnapshots, resolveRunEventsFile, snapshotFromEvents, summarizeEval } from "./runs";
import { loadReceipt } from "./receipt";
import { VERSION } from "./version";
import { WORKFLOWS } from "./workflows";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface JsonRpcRequest {
  jsonrpc?: "2.0";
  id?: string | number;
  method?: string;
  params?: {
    name?: string;
    arguments?: Record<string, unknown>;
  } & Record<string, unknown>;
}

const tools: Json[] = [
  {
    name: "oneshot_run",
    description: "Run a oneshot task locally and return after the pipeline finishes.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        task: { type: "string" },
        workflow: { type: "string" },
        dryRun: { type: "boolean" },
      },
      required: ["repo", "task"],
      additionalProperties: false,
    },
  },
  {
    name: "oneshot_runs_list",
    description: "List recent durable oneshot runs from the local run ledger.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 100 } },
      additionalProperties: false,
    },
  },
  {
    name: "oneshot_run_status",
    description: "Read a run snapshot by run id or events file path.",
    inputSchema: {
      type: "object",
      properties: { run: { type: "string" }, recentActions: { type: "integer", minimum: 1, maximum: 25 } },
      required: ["run"],
      additionalProperties: false,
    },
  },
  {
    name: "oneshot_receipt",
    description: "Read a run's proof-of-work receipt (plan, review, policy, confidence) by run id or events file.",
    inputSchema: {
      type: "object",
      properties: { run: { type: "string" } },
      required: ["run"],
      additionalProperties: false,
    },
  },
  {
    name: "oneshot_policy_init",
    description: "Create a default .oneshot/policy.json in a repo or directory.",
    inputSchema: {
      type: "object",
      properties: { targetDir: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "oneshot_workflows_list",
    description: "List built-in oneshot workflow presets.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "oneshot_eval_summary",
    description: "Summarize local run outcomes for routing and workflow evaluation.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 100 } },
      additionalProperties: false,
    },
  },
] as Json[];

const textResult = (value: unknown): { content: Array<{ type: "text"; text: string }> } => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

const asString = (value: unknown, name: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value;
};

const callTool = async (name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
  if (name === "oneshot_runs_list") {
    return listRunSnapshots(typeof args.limit === "number" ? args.limit : 20);
  }
  if (name === "oneshot_run_status") {
    const eventsFile = resolveRunEventsFile(asString(args.run, "run"));
    return snapshotFromEvents(eventsFile, typeof args.recentActions === "number" ? args.recentActions : 8);
  }
  if (name === "oneshot_receipt") {
    return loadReceipt(asString(args.run, "run"));
  }
  if (name === "oneshot_policy_init") {
    return { path: initPolicy(typeof args.targetDir === "string" ? args.targetDir : process.cwd()) };
  }
  if (name === "oneshot_workflows_list") {
    return WORKFLOWS;
  }
  if (name === "oneshot_eval_summary") {
    return summarizeEval(listRunSnapshots(typeof args.limit === "number" ? args.limit : 100));
  }
  if (name === "oneshot_run") {
    const config = await loadLocalConfig();
    const options: OneshotOptions = {
      repo: asString(args.repo, "repo"),
      task: asString(args.task, "task"),
      workflow: typeof args.workflow === "string" ? args.workflow : undefined,
      dryRun: args.dryRun === true,
    };
    await runPipeline(config, options);
    return { ok: true };
  }
  throw new Error(`unknown tool: ${name}`);
};

const send = (message: Json): void => {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
};

const respond = (id: JsonRpcRequest["id"], result: Json): void => {
  if (id == null) return;
  send({ jsonrpc: "2.0", id, result });
};

const fail = (id: JsonRpcRequest["id"], error: Error): void => {
  if (id == null) return;
  send({ jsonrpc: "2.0", id, error: { code: -32000, message: error.message } });
};

const handle = async (request: JsonRpcRequest): Promise<void> => {
  try {
    if (request.method === "initialize") {
      respond(request.id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "oneshot-cli", version: VERSION },
      });
      return;
    }
    if (request.method === "tools/list") {
      respond(request.id, { tools });
      return;
    }
    if (request.method === "tools/call") {
      const name = asString(request.params?.name, "name");
      const args = request.params?.arguments ?? {};
      respond(request.id, textResult(await callTool(name, args)) as unknown as Json);
      return;
    }
    if (request.id != null) respond(request.id, {});
  } catch (err) {
    fail(request.id, err instanceof Error ? err : new Error(String(err)));
  }
};

export const runMcpServer = (): void => {
  let buffer = Buffer.alloc(0);
  process.stdin.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = buffer.slice(0, headerEnd).toString("utf-8");
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        buffer = buffer.slice(headerEnd + 4);
        continue;
      }
      const length = Number.parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (buffer.length < bodyEnd) return;
      const body = buffer.slice(bodyStart, bodyEnd).toString("utf-8");
      buffer = buffer.slice(bodyEnd);
      try {
        void handle(JSON.parse(body) as JsonRpcRequest);
      } catch (err) {
        fail(undefined, err instanceof Error ? err : new Error(String(err)));
      }
    }
  });
};
