import { existsSync, mkdirSync, writeFileSync, renameSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

export interface OneshotConfig {
  host: string;
  basePath: string;
  worktreeRoot?: string;
  linearApiKey?: string;
  anthropicApiKey?: string;
  claude: {
    model: string;
    timeoutMinutes: number;
  };
  codex: {
    model: string;
    reasoningEffort: string;
    reviewModel?: string;
    reviewReasoningEffort?: string;
    timeoutMinutes: number;
  };
  phases?: Partial<Record<PhaseName, PhaseAgentConfig>>;
  stepTimeouts?: {
    planMinutes?: number;
    executeMinutes?: number;
    reviewMinutes?: number;
    deepReviewMinutes?: number;
    prMinutes?: number;
  };
}

export interface OneshotOptions {
  repo: string;
  task: string;
  taskSummary?: string;
  model?: string;
  branch?: string;
  basePath?: string;
  worktreeRoot?: string;
  mode?: ComplexityMode;
  dryRun?: boolean;
  deepReview?: boolean;
  linearIssueId?: string;
  eventsFile?: string;
}

export type ComplexityMode = 'fast' | 'deep';

export type AgentProvider = "claude" | "codex";
export type PhaseName = "classify" | "plan" | "execute" | "review" | "deepReview" | "pr";

export interface PhaseAgentConfig {
  provider: AgentProvider;
  model: string;
  reasoningEffort?: string;
}

export interface PipelineContext {
  config: OneshotConfig;
  options: OneshotOptions;
  runId: string;
  repoPath: string;
  worktreePath: string;
  worktreeRoot: string;
  plan: string;
  prUrl: string;
  startTime: number;
  mode: ComplexityMode;
}

const DEFAULT_CONFIG: Omit<OneshotConfig, "host"> = {
  basePath: "~/projects",
  worktreeRoot: "/tmp",
  claude: {
    model: "opus",
    timeoutMinutes: 180,
  },
  codex: {
    model: "gpt-5.5",
    reasoningEffort: "xhigh",
    reviewModel: "gpt-5.5",
    reviewReasoningEffort: "xhigh",
    timeoutMinutes: 180,
  },
};

export const CONFIG_DIR = join(homedir(), ".oneshot");
export const CONFIG_PATH = process.env.ONESHOT_CONFIG_PATH || join(CONFIG_DIR, "config.json");

const asPositiveMinutes = (value: unknown, fallback: number): number => {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
};

const asOptionalString = (value: unknown): string | undefined => {
  return typeof value === "string" && value.trim() ? value : undefined;
};

const asAgentProvider = (value: unknown, fallback: AgentProvider): AgentProvider => {
  return value === "claude" || value === "codex" ? value : fallback;
};

const parseConfigFile = async (): Promise<Partial<OneshotConfig>> => {
  const rawText = await Bun.file(CONFIG_PATH).text();
  let raw: Partial<OneshotConfig>;
  try {
    raw = JSON.parse(rawText) as Partial<OneshotConfig>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`invalid config JSON in ${CONFIG_PATH}: ${msg}`);
  }

  return raw;
};

export const normalizeConfig = (
  raw: Partial<OneshotConfig>,
  options: { requireHost: boolean }
): OneshotConfig => {
  const host = asOptionalString(raw.host);
  if (options.requireHost && !host) {
    throw new Error("host is required in ~/.oneshot/config.json");
  }
  const codexModel = asOptionalString(raw.codex?.model) ?? DEFAULT_CONFIG.codex.model;
  const codexReasoningEffort =
    asOptionalString(raw.codex?.reasoningEffort) ?? DEFAULT_CONFIG.codex.reasoningEffort;

  const config: OneshotConfig = {
    ...DEFAULT_CONFIG,
    ...raw,
    host: host ?? "local",
    basePath: asOptionalString(raw.basePath) ?? DEFAULT_CONFIG.basePath,
    worktreeRoot: asOptionalString(raw.worktreeRoot) ?? DEFAULT_CONFIG.worktreeRoot,
    linearApiKey: asOptionalString(raw.linearApiKey),
    anthropicApiKey: asOptionalString(raw.anthropicApiKey),
    claude: {
      ...DEFAULT_CONFIG.claude,
      ...raw.claude,
      model: asOptionalString(raw.claude?.model) ?? DEFAULT_CONFIG.claude.model,
      timeoutMinutes: asPositiveMinutes(
        raw.claude?.timeoutMinutes,
        DEFAULT_CONFIG.claude.timeoutMinutes
      ),
    },
    codex: {
      ...DEFAULT_CONFIG.codex,
      ...raw.codex,
      model: codexModel,
      reasoningEffort: codexReasoningEffort,
      reviewModel: asOptionalString(raw.codex?.reviewModel) ?? codexModel,
      reviewReasoningEffort:
        asOptionalString(raw.codex?.reviewReasoningEffort) ?? codexReasoningEffort,
      timeoutMinutes: asPositiveMinutes(
        raw.codex?.timeoutMinutes,
        DEFAULT_CONFIG.codex.timeoutMinutes
      ),
    },
    stepTimeouts: raw.stepTimeouts
      ? {
          planMinutes: asPositiveMinutes(
            raw.stepTimeouts.planMinutes,
            DEFAULT_STEP_TIMEOUTS.planMinutes
          ),
          executeMinutes: asPositiveMinutes(
            raw.stepTimeouts.executeMinutes,
            DEFAULT_STEP_TIMEOUTS.executeMinutes
          ),
          reviewMinutes: asPositiveMinutes(
            raw.stepTimeouts.reviewMinutes,
            DEFAULT_STEP_TIMEOUTS.reviewMinutes
          ),
          deepReviewMinutes: asPositiveMinutes(
            raw.stepTimeouts.deepReviewMinutes,
            DEFAULT_STEP_TIMEOUTS.deepReviewMinutes
          ),
          prMinutes: asPositiveMinutes(
            raw.stepTimeouts.prMinutes,
            DEFAULT_STEP_TIMEOUTS.prMinutes
          ),
        }
      : undefined,
  };

  config.phases = normalizePhases(raw.phases, buildLegacyPhaseDefaults(config));
  return config;
};

export const loadConfig = async (): Promise<OneshotConfig> => {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(
      "no config found. run `oneshot init` to set up your configuration"
    );
  }

  return normalizeConfig(await parseConfigFile(), { requireHost: true });
};

export const loadLocalConfig = async (): Promise<OneshotConfig> => {
  if (!existsSync(CONFIG_PATH)) {
    return normalizeConfig({}, { requireHost: false });
  }

  return normalizeConfig(await parseConfigFile(), { requireHost: false });
};

export const saveConfig = (config: OneshotConfig): void => {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  const tmpPath = `${CONFIG_PATH}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(config, null, 2) + "\n");
  renameSync(tmpPath, CONFIG_PATH);
};

const DEFAULT_STEP_TIMEOUTS = {
  planMinutes: 60,
  executeMinutes: 180,
  reviewMinutes: 60,
  deepReviewMinutes: 60,
  prMinutes: 60,
};

const PHASES: PhaseName[] = ["classify", "plan", "execute", "review", "deepReview", "pr"];

const buildLegacyPhaseDefaults = (
  config: Pick<OneshotConfig, "claude" | "codex">
): Record<PhaseName, PhaseAgentConfig> => ({
  classify: {
    provider: "claude",
    model: "haiku",
  },
  plan: {
    provider: "claude",
    model: config.claude.model,
  },
  execute: {
    provider: "codex",
    model: config.codex.model,
    reasoningEffort: config.codex.reasoningEffort,
  },
  review: {
    provider: "codex",
    model: config.codex.reviewModel ?? config.codex.model,
    reasoningEffort: config.codex.reviewReasoningEffort ?? config.codex.reasoningEffort,
  },
  deepReview: {
    provider: "codex",
    model: config.codex.reviewModel ?? config.codex.model,
    reasoningEffort: config.codex.reviewReasoningEffort ?? config.codex.reasoningEffort,
  },
  pr: {
    provider: "claude",
    model: config.claude.model,
  },
});

const normalizePhase = (
  raw: PhaseAgentConfig | undefined,
  fallback: PhaseAgentConfig
): PhaseAgentConfig => {
  const provider = asAgentProvider(raw?.provider, fallback.provider);
  return {
    provider,
    model: asOptionalString(raw?.model) ?? fallback.model,
    reasoningEffort:
      provider === "codex"
        ? asOptionalString(raw?.reasoningEffort) ?? fallback.reasoningEffort ?? "xhigh"
        : undefined,
  };
};

const normalizePhases = (
  raw: Partial<Record<PhaseName, PhaseAgentConfig>> | undefined,
  defaults: Record<PhaseName, PhaseAgentConfig>
): Record<PhaseName, PhaseAgentConfig> => {
  const phases = {} as Record<PhaseName, PhaseAgentConfig>;
  for (const phase of PHASES) {
    phases[phase] = normalizePhase(raw?.[phase], defaults[phase]);
  }
  return phases;
};

export const getPhaseAgent = (
  config: Pick<OneshotConfig, "claude" | "codex" | "phases">,
  phase: PhaseName
): PhaseAgentConfig => {
  return normalizePhase(config.phases?.[phase], buildLegacyPhaseDefaults(config)[phase]);
};

export type StepTimeoutKey = keyof typeof DEFAULT_STEP_TIMEOUTS;

export const getStepTimeout = (config: OneshotConfig, step: StepTimeoutKey): number => {
  const minutes = config.stepTimeouts?.[step] ?? DEFAULT_STEP_TIMEOUTS[step];
  return minutes * 60 * 1000;
};
