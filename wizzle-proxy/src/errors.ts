import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export function jsonError(context: Context, error: HttpError) {
  return context.json(
    {
      error: {
        message: error.message,
        type: error.code,
        param: null,
        code: error.code
      }
    },
    error.status as ContentfulStatusCode
  );
}
