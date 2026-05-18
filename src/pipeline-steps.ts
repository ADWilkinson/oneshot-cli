/**
 * Canonical step catalogue for the oneshot pipeline.
 *
 * The CLI emits step numbers + labels via events.ts; the bot consumes them
 * and maps step numbers back to short display names. Keeping the list here
 * means renaming a label in pipeline.ts doesn't silently desync the bot's
 * progress card — both sides derive from this single source.
 *
 * Steps 1..N are executed in order. `short` is the terse ops-speak name
 * surfaced in Slack/web progress cards.
 */

export interface OneshotStep {
  readonly step: number;
  readonly label: string;
  readonly short: string;
}

export const ONESHOT_STEPS: readonly OneshotStep[] = [
  { step: 1, label: 'Validating repo',      short: 'recon' },
  { step: 2, label: 'Creating worktree',    short: 'infiltrate' },
  { step: 3, label: 'Classifying task',     short: 'classify' },
  { step: 4, label: 'Planning change', short: 'strategize' },
  { step: 5, label: 'Executing change', short: 'engage' },
  { step: 6, label: 'Creating draft PR',    short: 'extract' },
  { step: 7, label: 'Reviewing diff', short: 'sweep' },
  { step: 8, label: 'Finalizing PR',        short: 'finalize' },
] as const;

export const ONESHOT_TOTAL_STEPS = ONESHOT_STEPS.length;

export const getStepLabel = (step: number): string =>
  ONESHOT_STEPS.find(s => s.step === step)?.label ?? `step ${step}`;

export const getStepShort = (step: number): string =>
  ONESHOT_STEPS.find(s => s.step === step)?.short ?? `step ${step}`;
