import type { PipelineContext } from "../config";
import { execOrThrow, gitRetry } from "../exec";
import { shellEscape } from "../shell";

export const validate = async (ctx: PipelineContext): Promise<void> => {
  const { repoPath } = ctx;
  await execOrThrow(`test -d ${shellEscape(`${repoPath}/.git`)} || test -f ${shellEscape(`${repoPath}/.git`)}`);
  await gitRetry(`cd ${shellEscape(repoPath)} && git fetch origin`);
};
