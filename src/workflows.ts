import type { ComplexityMode } from "./config";

export interface WorkflowPreset {
  name: string;
  description: string;
  taskPrefix: string;
  mode: ComplexityMode;
  deepReview?: boolean;
}

export const WORKFLOWS: WorkflowPreset[] = [
  {
    name: "ship",
    description: "Implement, verify, review, and open a shippable PR.",
    taskPrefix: "Ship this end to end. Implement the requested change, run the relevant checks, review the diff, and open a ready PR.",
    mode: "deep",
    deepReview: true,
  },
  {
    name: "review",
    description: "Review an existing diff or PR and fix confirmed issues.",
    taskPrefix: "Review this like a senior engineer. Confirm issues against the real code path, fix confirmed bugs directly, and leave the PR shippable.",
    mode: "deep",
    deepReview: true,
  },
  {
    name: "fix-ci",
    description: "Diagnose failing checks, patch the root cause, and rerun the focused gate.",
    taskPrefix: "Fix CI. Inspect the failing check output, patch the root cause, and rerun the focused validation before opening the PR.",
    mode: "deep",
  },
  {
    name: "research",
    description: "Inspect and explain without code changes unless explicitly requested.",
    taskPrefix: "Research this thoroughly. Prefer read-only inspection and produce a grounded answer with file references. Do not edit code unless the task explicitly asks for changes.",
    mode: "deep",
  },
  {
    name: "docs",
    description: "Update public docs, examples, and changelog-style explanation.",
    taskPrefix: "Update the docs with accurate examples and user-facing explanation. Keep code changes minimal unless needed for documentation correctness.",
    mode: "fast",
  },
  {
    name: "swarm-review",
    description: "Run a broad multi-angle review and fix confirmed critical or major findings.",
    taskPrefix: "Run a swarm-style review: inspect architecture, tests, security, regression risk, and user-facing behavior. Fix confirmed critical or major issues inline, then summarize residual risk.",
    mode: "deep",
    deepReview: true,
  },
];

export const getWorkflow = (name: string | undefined): WorkflowPreset | undefined => {
  if (!name) return undefined;
  return WORKFLOWS.find((workflow) => workflow.name === name);
};

export const applyWorkflow = (
  task: string,
  workflow: WorkflowPreset | undefined,
): string => {
  if (!workflow) return task;
  return `${workflow.taskPrefix}\n\nUser task:\n${task}`;
};
