import type { AgentProvider, ComplexityMode, OneshotConfig, PhaseName, PhaseAgentConfig } from "./config";
import { getPhaseAgent } from "./config";

export type RoutingReasoning = "low" | "medium" | "high" | "xhigh";
export type ContextShape = "minimal" | "focused" | "full";
export type ExecutionStyle = "answer" | "inspect" | "edit" | "edit-verify" | "edit-verify-ship" | "tool-ops";
export type VerificationProfile = "none" | "focused" | "full" | "deploy-health";

export interface RouteDecision {
  enabled: boolean;
  provider: AgentProvider;
  mode: ComplexityMode;
  reasoningEffort: RoutingReasoning;
  contextShape: ContextShape;
  executionStyle: ExecutionStyle;
  verification: VerificationProfile;
  reason: string;
  phaseReasoning: Partial<Record<PhaseName, RoutingReasoning>>;
}

export interface RouteTaskOptions {
  defaultProvider: AgentProvider;
  routingEnabled?: boolean;
  modeOverride?: ComplexityMode;
}

const SIMPLE_RE = /\b(?:typo|rename|bump|version|copy|text|readme|comment|config|env|lint|format|small|quick)\b/i;
const CODE_RE = /\b(?:fix|repair|implement|build|add|create|wire|refactor|test|typecheck|code|bug|failing|failed|regression|pr|pull request|review|sdk|api|component|route|deploy.*code|ship|land)\b/i;
const TOOL_OPS_RE = /\b(?:browser|click|screenshot|slack|gmail|email|calendar|notion|linear|figma|desktop|app|logs?|journalctl|systemd|ssh|restart|redeploy|deploy|vercel|firebase|railway|infisical|secret|env|config|monitor|watch|check health|status)\b/i;
const DEEP_RE = /\b(?:prod|production|release|deploy|restart|systemd|logs?|promote|migrate|migration|auth|wallet|funds?|money|payment|onboarding|architecture|refactor|review|audit|deep|study|investigate|root cause|timeout|flaky|incident|outage|multi[- ]?file|sibling surfaces?)\b/i;
const SHIP_RE = /\b(?:ship|land|open a pr|make a pr|merge|publish|release|deploy|push)\b/i;

export function routeTask(task: string, opts: RouteTaskOptions): RouteDecision {
  const text = task.trim();
  const length = text.length;
  const simple = SIMPLE_RE.test(text) && length < 160 && !DEEP_RE.test(text);
  const code = CODE_RE.test(text);
  const toolOps = TOOL_OPS_RE.test(text);
  const deepSignal = DEEP_RE.test(text) || length > 500;
  const ships = SHIP_RE.test(text);

  const mode = opts.modeOverride ?? (simple ? "fast" : "deep");
  const enabled = opts.routingEnabled === true;
  const provider = enabled && toolOps && !code ? "claude" : opts.defaultProvider;
  const contextShape: ContextShape = deepSignal || mode === "deep" ? "full" : simple ? "minimal" : "focused";
  const executionStyle: ExecutionStyle = ships
    ? "edit-verify-ship"
    : toolOps && !code
      ? "tool-ops"
      : code
        ? mode === "deep" ? "edit-verify" : "edit"
        : "inspect";
  const verification: VerificationProfile = ships || /\b(?:deploy|restart|release|publish|promote|health)\b/i.test(text)
    ? "deploy-health"
    : mode === "deep"
      ? "full"
      : code
        ? "focused"
        : "none";
  const reasoningEffort: RoutingReasoning = deepSignal || ships
    ? "xhigh"
    : mode === "deep"
      ? "high"
      : simple
        ? "medium"
        : "high";
  const reason = !enabled
    ? `adaptive routing disabled; using configured ${opts.defaultProvider} provider`
    : provider === "claude"
      ? "tool-heavy or operations-dominant task; using Claude frontier with adaptive effort"
      : "code or ship-dominant task; using Codex frontier with adaptive effort";

  return {
    enabled,
    provider,
    mode,
    reasoningEffort,
    contextShape,
    executionStyle,
    verification,
    reason,
    phaseReasoning: {
      classify: simple ? "low" : "medium",
      plan: reasoningEffort,
      execute: reasoningEffort,
      review: mode === "deep" ? "xhigh" : "high",
      deepReview: "xhigh",
      pr: ships ? "high" : "medium",
    },
  };
}

export function renderRouteDecision(route: RouteDecision): string {
  return [
    `provider=${route.provider}`,
    `mode=${route.mode}`,
    `reasoning=${route.reasoningEffort}`,
    `context=${route.contextShape}`,
    `execution=${route.executionStyle}`,
    `verification=${route.verification}`,
  ].join(", ");
}

const phaseModel = (
  config: OneshotConfig,
  provider: AgentProvider,
  phase: PhaseName,
  modelOverride?: string,
): string => {
  if (modelOverride && (phase === "plan" || phase === "pr")) return modelOverride;
  if (provider === "claude") return config.claude.model;
  if (phase === "review" || phase === "deepReview") return config.codex.reviewModel ?? config.codex.model;
  return config.codex.model;
};

export function getRoutedPhaseAgent(
  config: OneshotConfig,
  phase: PhaseName,
  route: RouteDecision | undefined,
  modelOverride?: string,
): PhaseAgentConfig {
  if (!route?.enabled) {
    const agent = getPhaseAgent(config, phase);
    if (!modelOverride || (phase !== "plan" && phase !== "pr")) return agent;
    return { ...agent, model: modelOverride };
  }

  const provider = route.provider;
  return {
    provider,
    model: phaseModel(config, provider, phase, modelOverride),
    reasoningEffort: route.phaseReasoning[phase] ?? route.reasoningEffort,
  };
}
