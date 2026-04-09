import { VERSION } from "./version";
import { ONESHOT_TOTAL_STEPS } from "./steps";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";

const STEPS_TOTAL = ONESHOT_TOTAL_STEPS;

export const log = {
  header: () => {
    console.log(`\n${BOLD}${CYAN}oneshot${RESET} ${DIM}v${VERSION}${RESET}\n`);
  },

  stepStart: (step: number, message: string) => {
    process.stdout.write(
      `${DIM}[${step}/${STEPS_TOTAL}]${RESET} ${message}...`
    );
  },

  stepDone: (elapsed: number) => {
    console.log(`  ${GREEN}\u2713${RESET} ${DIM}${formatTime(elapsed)}${RESET}`);
  },

  stepFail: (elapsed: number) => {
    console.log(`  ${RED}\u2717${RESET} ${DIM}${formatTime(elapsed)}${RESET}`);
  },

  info: (message: string) => {
    console.log(`  ${DIM}${message}${RESET}`);
  },

  warn: (message: string) => {
    console.log(`  ${YELLOW}${message}${RESET}`);
  },

  error: (message: string) => {
    console.error(`\n${RED}error:${RESET} ${message}`);
  },

  summary: (prUrl: string, filesChanged: number, totalElapsed: number) => {
    console.log();
    console.log(`${BOLD}PR:${RESET} ${prUrl}`);
    console.log(`${BOLD}Files changed:${RESET} ${filesChanged}`);
    console.log(`${BOLD}Time:${RESET} ${formatTime(totalElapsed)}`);
    console.log();
  },

  dryRunSummary: (remotePath: string) => {
    console.log();
    console.log(`${BOLD}${GREEN}Dry run complete${RESET}`);
    console.log(`${BOLD}Remote path:${RESET} ${remotePath}`);
    console.log();
  },
};

export const formatTime = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.round(seconds % 60);
  return `${minutes}m ${remaining}s`;
};
