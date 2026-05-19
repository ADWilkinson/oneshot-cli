import type { PipelineContext, ComplexityMode } from "../config";
import { routeTask } from "../routing";

export const classify = async (ctx: PipelineContext): Promise<ComplexityMode> => {
  const { options } = ctx;
  if (options.mode) return options.mode;

  return routeTask(options.task, {
    defaultProvider: ctx.config.provider,
    routingEnabled: ctx.config.routing?.enabled,
  }).mode;
};
