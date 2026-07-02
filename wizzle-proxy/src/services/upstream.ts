import { z } from "zod";

import { HttpError } from "../errors.js";
import type { AppConfig, ReasoningLevel } from "../types.js";

const chatRequestSchema = z
  .object({
    model: z.string().min(1).optional(),
    messages: z.array(z.unknown()).min(1),
    stream: z.boolean().optional()
  })
  .passthrough();

export type ChatRequest = z.infer<typeof chatRequestSchema>;

export function parseChatRequest(body: unknown): ChatRequest {
  return chatRequestSchema.parse(body);
}

export async function readJsonBody(request: Request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "invalid_request", "Invalid JSON body");
  }
}

export function withDefaultModel(body: ChatRequest, config: AppConfig): ChatRequest {
  return { ...body, model: body.model ?? config.defaultModel };
}

export function resolveUpstreamRequest(
  body: ChatRequest,
  reasoningLevel: ReasoningLevel,
  config: AppConfig
) {
  const publicModel = body.model ?? config.defaultModel;
  const modelConfig = config.models[publicModel];

  if (!modelConfig) {
    throw new HttpError(400, "invalid_model", "Requested model is not allowed");
  }

  const { model: _publicModel, reasoning: _ignoredReasoning, ...rest } = body as ChatRequest & {
    reasoning?: unknown;
  };

  return {
    publicModel,
    path: modelConfig.upstream.path,
    body: {
      ...rest,
      model: modelConfig.upstream.model,
      reasoning: {
        effort: modelConfig.reasoningMap[reasoningLevel]
      }
    }
  };
}

export function createUpstreamCaller(options: {
  baseUrl: string;
  apiKey: string;
}) {
  return async (
    request: {
      path: string;
      body: Record<string, unknown>;
    },
    signal: AbortSignal
  ) => {
    let response: Response;

    try {
      const headers: Record<string, string> = {
        "content-type": "application/json"
      };

      if (options.apiKey) {
        headers.authorization = `Bearer ${options.apiKey}`;
      }

      response = await fetch(`${options.baseUrl}${request.path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(request.body),
        signal
      });
    } catch {
      throw new HttpError(502, "upstream_unreachable", "Upstream request failed");
    }

    if (!response.ok) {
      throw new HttpError(502, "upstream_error", "Upstream returned an error");
    }

    return response;
  };
}

export async function readUpstreamJson(response: Response) {
  try {
    return await response.json();
  } catch {
    throw new HttpError(502, "invalid_upstream_response", "Upstream returned invalid JSON");
  }
}

export function forwardStreamResponse(response: Response, requestId: string) {
  if (!response.body) {
    throw new HttpError(502, "invalid_upstream_response", "Upstream returned an empty stream");
  }

  return new Response(response.body, {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") ?? "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      "x-request-id": requestId
    }
  });
}
