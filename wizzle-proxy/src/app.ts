import { Hono } from "hono";
import { ZodError } from "zod";

import { HttpError, jsonError } from "./errors.js";
import { createAuthMiddleware } from "./middleware/auth.js";
import { createLoggingMiddleware } from "./middleware/logging.js";
import { requestIdMiddleware } from "./middleware/request-id.js";
import { validateChatHeadersMiddleware } from "./middleware/validate-chat-headers.js";
import {
  parseChatRequest,
  readJsonBody,
  readUpstreamJson,
  resolveUpstreamRequest,
  forwardStreamResponse,
  withDefaultModel
} from "./services/upstream.js";
import type { AppBindings, AppConfig, AuthVerifier, Logger } from "./types.js";
import type { ChatRequest } from "./services/upstream.js";

type CreateAppOptions = {
  config: AppConfig;
  verifyIdToken: AuthVerifier;
  callUpstream: (
    request: {
      path: string;
      body: Record<string, unknown>;
    },
    signal: AbortSignal
  ) => Promise<Response>;
  logger: Logger;
};

export function createApp(options: CreateAppOptions) {
  const app = new Hono<AppBindings>();

  app.onError((error, context) => {
    if (error instanceof HttpError) {
      return jsonError(context, error);
    }

    if (error instanceof ZodError) {
      return jsonError(context, new HttpError(400, "invalid_request", "Invalid request body"));
    }

    console.error(error);
    return jsonError(context, new HttpError(500, "internal_error", "Internal server error"));
  });

  app.use("*", requestIdMiddleware);
  app.use("*", createLoggingMiddleware(options.logger));

  app.get("/health", (context) =>
    context.json({
      status: "ok"
    })
  );

  app.use("/v1/*", createAuthMiddleware(options.verifyIdToken));

  app.get("/v1/models", (context) =>
    context.json({
      object: "list",
      data: Object.values(options.config.models).map((model) => ({
        id: model.id,
        object: "model",
        created: 0,
        owned_by: "wizzle"
      }))
    })
  );

  app.post("/v1/chat/completions", validateChatHeadersMiddleware, async (context) => {
    const publicBody = withDefaultModel(
      parseChatRequest(await readJsonBody(context.req.raw)),
      options.config
    );
    const reasoningLevel = context.get("reasoningLevel");

    if (!reasoningLevel) {
      throw new HttpError(400, "invalid_headers", "Missing required header: X-Wizzle-Reasoning-Level");
    }

    const upstreamRequest = resolveUpstreamRequest(
      publicBody,
      reasoningLevel,
      options.config
    );

    context.set("model", upstreamRequest.publicModel);

    try {
      const upstreamResponse = await options.callUpstream(upstreamRequest, context.req.raw.signal);

      if (publicBody.stream) {
        return forwardStreamResponse(upstreamResponse, context.get("requestId"));
      }

      return context.json(await readUpstreamJson(upstreamResponse), upstreamResponse.status as 200);
    } catch (error) {
      if (error instanceof HttpError && error.code.startsWith("upstream")) {
        context.set("upstreamError", error.code);
      }

      throw error;
    }
  });

  app.notFound(() => {
    throw new HttpError(404, "not_found", "Route not found");
  });

  return app;
}
