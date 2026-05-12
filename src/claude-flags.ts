import { shellEscape } from "./shell";

/**
 * Flags applied to every internal `claude -p` invocation we make for
 * planner / classifier / PR-metadata steps.
 *
 * Why: those steps only need the LLM to read the repo and write text.
 * They don't need browser automation, codex, firebase, or any other MCP
 * server. By default `claude -p` merges the user's global MCP config
 * (`~/.claude.json`), which boots chrome-devtools-mcp, agentation-mcp,
 * codex mcp-server, firebase mcp, context7-mcp on every call. Several
 * of those fork watchdog children that survive parent death and leak
 * into the parent's cgroup. When oneshot is dispatched under a systemd
 * service (e.g. oneshot-bot on andrew-dev), the leaks accumulate and
 * trip the cgroup's TasksMax, after which bun crashes with "Failed to
 * start HTTP Client thread: SystemResources" partway through step 4.
 *
 * The fix: pass `--strict-mcp-config` to disable auto-loading of the
 * user + project MCP config, and `--mcp-config '{"mcpServers":{}}'` to
 * make the empty set explicit. The execute + review steps run on codex,
 * not claude, so they're untouched.
 */
const EMPTY_MCP_CONFIG = '{"mcpServers":{}}';

export const internalClaudeFlags = (): string =>
  `--strict-mcp-config --mcp-config ${shellEscape(EMPTY_MCP_CONFIG)}`;
