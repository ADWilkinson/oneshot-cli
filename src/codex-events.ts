import type { AgentActionPayload, AgentEventPhase, AgentEventKind } from "./events";

type JsonObject = Record<string, unknown>;

const MAX_TITLE = 180;

const truncate = (value: string, max = MAX_TITLE): string =>
  value.length > max ? `${value.slice(0, max - 3)}...` : value;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const asBoolean = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

const phaseFromType = (type: string): AgentEventPhase | undefined => {
  if (type === "item.started") return "started";
  if (type === "item.updated") return "updated";
  if (type === "item.completed") return "completed";
  return undefined;
};

const action = (
  phase: AgentEventPhase,
  kind: AgentEventKind,
  title: string,
  opts: { ok?: boolean; detail?: Record<string, unknown> } = {},
): AgentActionPayload => ({
  phase,
  kind,
  title: truncate(title || kind),
  ...opts,
});

const summarizeToolResult = (result: unknown): Record<string, unknown> | undefined => {
  if (!isObject(result)) return undefined;

  const summary: Record<string, unknown> = {};
  const content = result.content;
  if (Array.isArray(content)) {
    summary.contentBlocks = content.length;
  } else if (content != null) {
    summary.contentBlocks = 1;
  }

  if ("structured_content" in result) {
    summary.hasStructured = result.structured_content != null;
  } else if ("structured" in result) {
    summary.hasStructured = result.structured != null;
  }

  return Object.keys(summary).length > 0 ? summary : undefined;
};

const normalizeChanges = (changes: unknown): Array<{ path: string; kind?: string }> => {
  if (!Array.isArray(changes)) return [];
  const normalized: Array<{ path: string; kind?: string }> = [];

  for (const change of changes) {
    if (!isObject(change)) continue;
    const path = asString(change.path);
    if (!path) continue;
    const kind = asString(change.kind);
    normalized.push(kind ? { path, kind } : { path });
  }

  return normalized;
};

const formatChangeSummary = (changes: unknown): string => {
  const paths = normalizeChanges(changes).map(change => change.path);
  if (paths.length === 0) return "files";
  return paths.slice(0, 4).join(", ") + (paths.length > 4 ? ` +${paths.length - 4}` : "");
};

const summarizeTodoList = (items: unknown): { done: number; total: number; next?: string } => {
  if (!Array.isArray(items)) return { done: 0, total: 0 };

  let done = 0;
  let total = 0;
  let next: string | undefined;

  for (const item of items) {
    if (!isObject(item)) continue;
    total++;
    if (item.completed === true) {
      done++;
      continue;
    }
    if (!next) next = asString(item.text);
  }

  return { done, total, next };
};

const todoTitle = (summary: { done: number; total: number; next?: string }): string => {
  if (summary.total <= 0) return "todo";
  if (summary.next) return `todo ${summary.done}/${summary.total}: ${summary.next}`;
  return `todo ${summary.done}/${summary.total}: done`;
};

const shortToolName = (server: unknown, tool: unknown): string => {
  const parts = [asString(server), asString(tool)].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(".") : "tool";
};

const translateItem = (
  phase: AgentEventPhase,
  item: JsonObject,
): AgentActionPayload[] => {
  const itemType = asString(item.type);
  const id = asString(item.id);
  const detailBase = id ? { id } : undefined;

  switch (itemType) {
    case "agent_message": {
      const text = asString(item.text);
      const messagePhase = asString(item.phase);
      if (!text || messagePhase !== "commentary") return [];
      return [action(phase, "note", text, { ok: phase === "completed" ? true : undefined, detail: { ...detailBase, phase: messagePhase } })];
    }
    case "reasoning": {
      const text = asString(item.text);
      if (!text) return [];
      return [action(phase, "note", text, { ok: phase === "completed" ? true : undefined, detail: detailBase })];
    }
    case "error": {
      const message = asString(item.message) ?? "codex error";
      if (phase !== "completed") return [];
      return [action("completed", "warning", message, { ok: false, detail: { ...detailBase, message } })];
    }
    case "command_execution": {
      const command = asString(item.command) ?? "command";
      const status = asString(item.status);
      const exitCode = typeof item.exit_code === "number" ? item.exit_code : undefined;
      const ok = phase === "completed"
        ? status === "completed" && (exitCode == null || exitCode === 0)
        : undefined;
      return [action(phase, "command", command, {
        ok,
        detail: { ...detailBase, status, exitCode, command },
      })];
    }
    case "mcp_tool_call": {
      const title = shortToolName(item.server, item.tool);
      const status = asString(item.status);
      const error = isObject(item.error) ? asString(item.error.message) : undefined;
      const resultSummary = summarizeToolResult(item.result);
      return [action(phase, "tool", title, {
        ok: phase === "completed" ? status === "completed" && !error : undefined,
        detail: {
          ...detailBase,
          server: item.server,
          tool: item.tool,
          status,
          arguments: item.arguments,
          error,
          resultSummary,
        },
      })];
    }
    case "web_search": {
      const query = asString(item.query) ?? "web search";
      return [action(phase, "web_search", query, { ok: phase === "completed" ? true : undefined, detail: { ...detailBase, query } })];
    }
    case "file_change": {
      if (phase !== "completed") return [];
      const changes = normalizeChanges(item.changes);
      const status = asString(item.status);
      return [action("completed", "file_change", formatChangeSummary(item.changes), {
        ok: status === "completed",
        detail: { ...detailBase, changes, status },
      })];
    }
    case "todo_list": {
      const summary = summarizeTodoList(item.items);
      return [action(phase, "todo", todoTitle(summary), {
        ok: phase === "completed" ? true : undefined,
        detail: { ...detailBase, done: summary.done, total: summary.total },
      })];
    }
    case "collab_tool_call": {
      const title = asString(item.tool) ?? "sub-agent";
      const status = asString(item.status);
      return [action(phase, "tool", title, {
        ok: phase === "completed" ? status === "completed" : undefined,
        detail: {
          ...detailBase,
          status,
          receiverThreadIds: item.receiver_thread_ids,
          agentsStates: item.agents_states,
        },
      })];
    }
    default:
      if (!itemType) return [];
      return [action(phase, "note", itemType, { ok: phase === "completed" ? asBoolean(item.ok) : undefined, detail: { ...detailBase, itemType } })];
  }
};

export const translateCodexJsonLine = (line: string): AgentActionPayload[] => {
  const trimmed = line.trim();
  if (!trimmed) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }

  if (!isObject(parsed)) return [];
  const type = asString(parsed.type);
  if (!type) return [];

  if (type === "thread.started") {
    const threadId = asString(parsed.thread_id);
    return [action("started", "session", threadId ? `codex session ${threadId}` : "codex session", { detail: { threadId } })];
  }

  if (type === "turn.started") {
    return [action("started", "turn", "turn started")];
  }

  if (type === "turn.completed") {
    return [action("completed", "turn", "turn completed", { ok: true, detail: { usage: parsed.usage } })];
  }

  if (type === "turn.failed") {
    const error = isObject(parsed.error) ? asString(parsed.error.message) : undefined;
    return [action("completed", "warning", error ?? "turn failed", { ok: false, detail: { error } })];
  }

  if (type === "error") {
    const message = asString(parsed.message) ?? "codex error";
    return [action("completed", "warning", message, { ok: false, detail: { message } })];
  }

  const phase = phaseFromType(type);
  if (!phase || !isObject(parsed.item)) return [];
  return translateItem(phase, parsed.item);
};
