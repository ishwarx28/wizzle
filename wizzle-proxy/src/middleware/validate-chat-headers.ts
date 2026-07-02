import type { MiddlewareHandler } from "hono";

import { HttpError } from "../errors.js";
import type { ReasoningLevel } from "../types.js";

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const reasoningLevels = new Set<ReasoningLevel>(["balanced", "max"]);

function requireHeader(name: string, value: string | undefined) {
  if (!value) {
    throw new HttpError(400, "invalid_headers", `Missing required header: ${name}`);
  }

  if (!idPattern.test(value)) {
    throw new HttpError(400, "invalid_headers", `Invalid header value: ${name}`);
  }

  return value;
}

function requireReasoningLevel(value: string | undefined): ReasoningLevel {
  if (value === "balanced" || value === "max") {
    return value;
  }

  throw new HttpError(
    400,
    "invalid_headers",
    "X-Wizzle-Reasoning-Level must be balanced or max"
  );
}

export const validateChatHeadersMiddleware: MiddlewareHandler = async (context, next) => {
  const contentType = context.req.header("content-type");

  if (!contentType?.toLowerCase().includes("application/json")) {
    throw new HttpError(400, "invalid_headers", "Content-Type must be application/json");
  }

  const projectId = requireHeader("X-Wizzle-Project-Id", context.req.header("x-wizzle-project-id"));
  const chatId = requireHeader("X-Wizzle-Chat-Id", context.req.header("x-wizzle-chat-id"));
  const reasoningLevel = requireReasoningLevel(context.req.header("x-wizzle-reasoning-level"));

  context.set("projectId", projectId);
  context.set("chatId", chatId);
  context.set("reasoningLevel", reasoningLevel);

  await next();
};
