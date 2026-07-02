import type { MiddlewareHandler } from "hono";
import { ZodError } from "zod";

import { HttpError } from "../errors.js";
import type { Logger } from "../types.js";

export function createLoggingMiddleware(logger: Logger): MiddlewareHandler {
  return async (context, next) => {
    const startedAt = Date.now();
    let status = 500;

    try {
      await next();
      status = context.res.status;
    } catch (error) {
      if (error instanceof HttpError) {
        status = error.status;
      } else if (error instanceof ZodError) {
        status = 400;
      }

      throw error;
    } finally {
      logger({
        requestId: context.get("requestId"),
        method: context.req.method,
        path: new URL(context.req.url).pathname,
        status: context.res ? context.res.status : status,
        latencyMs: Date.now() - startedAt,
        uid: context.get("uid"),
        model: context.get("model"),
        reasoningLevel: context.get("reasoningLevel"),
        upstreamError: context.get("upstreamError")
      });
    }
  };
}
