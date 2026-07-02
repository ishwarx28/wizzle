import type { MiddlewareHandler } from "hono";

import { HttpError } from "../errors.js";
import type { AuthVerifier } from "../types.js";

const bearerPattern = /^Bearer\s+(.+)$/i;

export function createAuthMiddleware(verifyIdToken: AuthVerifier): MiddlewareHandler {
  return async (context, next) => {
    const authorization = context.req.header("authorization");
    const match = authorization?.match(bearerPattern);

    if (!match?.[1]) {
      throw new HttpError(401, "invalid_auth", "Missing or invalid Authorization header");
    }

    const decodedToken = await verifyIdToken(match[1]);
    context.set("uid", decodedToken.uid);

    await next();
  };
}
