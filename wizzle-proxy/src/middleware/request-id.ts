import type { MiddlewareHandler } from "hono";

export const requestIdMiddleware: MiddlewareHandler = async (context, next) => {
  const requestId = crypto.randomUUID();

  context.set("requestId", requestId);
  context.header("X-Request-Id", requestId);

  await next();
};
