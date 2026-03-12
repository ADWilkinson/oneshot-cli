import { existsSync, mkdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface OneshotConfig {
  host: string;
  basePath: string;
  linearApiKey?: string;
  anthropicApiKey?: string;
  claude: {
    model: string;
    timeoutMinutes: number;
  };
  codex: {
    model: string;
    reasoningEffort: string;
    timeoutMinutes: number;
  };
  stepTimeouts?: {
    planMinutes?: number;
    executeMinutes?: number;
    reviewMinutes?: number;
    prMinutes?: number;
  };
}

export interface OneshotOptions {
  repo: string;
  task: string;
  taskSummary?: string;
  model?: string;
  branch?: string;
  dryRun?: boolean;
  linearIssueId?: string;
}

export interface PipelineContext {
  config: OneshotConfig;
  options: OneshotOptions;
  repoPath: string;
  worktreePath: string;
  plan: string;
  prUrl: string;
  startTime: number;
}

const DEFAULT_CONFIG: Omit<OneshotConfig, "host"> = {
  basePath: "~/projects",
  claude: {
    model: "opus",
    timeoutMinutes: 180,
  },
  codex: {
    model: "gpt-5.3-codex",
    reasoningEffort: "xhigh",
    timeoutMinutes: 180,
  },
};

export const CONFIG_DIR = join(homedir(), ".oneshot");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export const loadConfig = async (): Promise<OneshotConfig> => {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(
      "no config found. run `oneshot init` to set up your configuration"
    );
  }

  const raw = JSON.parse(await Bun.file(CONFIG_PATH).text());

  if (!raw.host) {
    throw new Error("host is required in ~/.oneshot/config.json");
  }

  return {
    ...DEFAULT_CONFIG,
    ...raw,
    claude: { ...DEFAULT_CONFIG.claude, ...raw.claude },
    codex: { ...DEFAULT_CONFIG.codex, ...raw.codex },
  };
};

export const saveConfig = (config: OneshotConfig): void => {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
};

const DEFAULT_STEP_TIMEOUTS = {
  planMinutes: 20,
  executeMinutes: 60,
  reviewMinutes: 20,
  prMinutes: 20,
};

export type StepTimeoutKey = keyof typeof DEFAULT_STEP_TIMEOUTS;

export const getStepTimeout = (config: OneshotConfig, step: StepTimeoutKey): number => {
  const minutes = config.stepTimeouts?.[step] ?? DEFAULT_STEP_TIMEOUTS[step];
  return minutes * 60 * 1000;
};
