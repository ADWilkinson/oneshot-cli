import type { PipelineContext } from "../config";
import { execOrThrow } from "../exec";

export const validate = async (ctx: PipelineContext): Promise<void> => {
  const { repoPath } = ctx;
  await execOrThrow(`test -d "${repoPath}/.git" || test -f "${repoPath}/.git"`);
  await execOrThrow(`cd "${repoPath}" && git fetch origin`);
};
