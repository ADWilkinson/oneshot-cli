import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const PKG_ROOT = join(__dirname, "..");
export const PROMPTS_DIR = join(PKG_ROOT, "prompts");

/**
 * Optional plugin-dir passed to every `claude -p` invocation in the pipeline.
 * When set, the dispatched agent inherits any skills exposed by the plugin at
 * this path (e.g. shared operational skills curated upstream). When unset,
 * the flag is simply omitted from the claude invocation and the pipeline
 * still runs normally against whatever skills exist in the target repo.
 *
 * Callers (e.g. oneshot-bot) set ONESHOT_CLAUDE_PLUGIN_DIR in the child env
 * to point at their own plugin directory. There is no default -- oneshot-cli
 * is repo-agnostic and never references paths outside the target worktree.
 */
export const CLAUDE_PLUGIN_DIR = process.env.ONESHOT_CLAUDE_PLUGIN_DIR ?? "";
