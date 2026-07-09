import type { Message, ToolCall } from "../../types/workspace";
import { formatExactMessageTimestamp } from "../../utils/time";
import type { OpenAIChatToolCall } from "../chat-stream";

export type ToolExecutionPayload = {
  error?: string | null;
  output?: string | null;
  status: string;
};

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;

    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseToolArguments(value: string): unknown {
  return parseJsonObject(value) ?? value;
}

function getStringField(record: Record<string, unknown>, field: string) {
  const value = record[field];

  return typeof value === "string" && value.trim() ? value : undefined;
}

function getNumberField(record: Record<string, unknown>, field: string) {
  const value = record[field];

  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function buildToolResultMetadata(options: {
  arguments: string;
  finishedAtMs: number;
  output: string;
  projectId?: string;
  startedAtMs?: number;
  status: string;
  toolName: string;
}) {
  const record = parseJsonObject(options.output) ?? {};

  return {
    arguments: parseToolArguments(options.arguments),
    contentHash: getStringField(record, "contentHash"),
    contentPath: getStringField(record, "contentPath") ?? getStringField(record, "path"),
    cwd: getStringField(record, "cwd"),
    exitCode: getNumberField(record, "exitCode"),
    finishedAtMs: options.finishedAtMs,
    projectId: options.projectId,
    realPath: getStringField(record, "realPath") ?? getStringField(record, "path"),
    startedAtMs: options.startedAtMs,
    status: options.status,
    timeout: getStringField(record, "timeout"),
    toolName: options.toolName,
  };
}

export function createAssistantMessage(turnId: string): Message {
  const timestamp = Date.now();

  return {
    assistantPhase: "pending",
    content: "",
    createdAtLabel: formatExactMessageTimestamp(timestamp),
    createdAtMs: timestamp,
    id: `message-assistant-${crypto.randomUUID()}`,
    parts: [],
    reasoning: "",
    role: "assistant",
    startedAtMs: timestamp,
    status: "streaming",
    toolCalls: [],
    toolResults: [],
    turnId,
  };
}

export function parseToolResultOutput(payload: ToolExecutionPayload) {
  if (payload.output?.trim()) {
    return payload.output;
  }

  if (payload.error?.trim()) {
    return JSON.stringify({
      error: payload.error,
      ok: false,
    });
  }

  return JSON.stringify({
    error: "The tool returned no output.",
    ok: false,
  });
}

export function createToolMessage(options: {
  parentPartId?: string;
  payload: ToolExecutionPayload;
  projectId?: string;
  startedAtMs?: number;
  toolCall: OpenAIChatToolCall;
  turnId: string;
}): Message {
  const timestamp = Date.now();
  const content = parseToolResultOutput(options.payload);
  const messageStatus =
    options.payload.status === "error"
      ? "error"
      : options.payload.status === "interrupted"
        ? "interrupted"
        : "done";

  return {
    completedAtMs: timestamp,
    content,
    createdAtLabel: formatExactMessageTimestamp(timestamp),
    createdAtMs: timestamp,
    id: `message-tool-${options.toolCall.id}`,
    parts: [
      {
        createdAtMs: timestamp,
        error: options.payload.error ?? undefined,
        id: `message-tool-${options.toolCall.id}-result`,
        metadata: buildToolResultMetadata({
          arguments: options.toolCall.function.arguments,
          finishedAtMs: timestamp,
          output: content,
          projectId: options.projectId,
          startedAtMs: options.startedAtMs,
          status: options.payload.status,
          toolName: options.toolCall.function.name,
        }),
        name: options.toolCall.function.name,
        output: content,
        parentPartId: options.parentPartId,
        status: options.payload.status,
        toolCallId: options.toolCall.id,
        type: "tool_result",
      },
    ],
    role: "tool",
    status: messageStatus,
    toolCallId: options.toolCall.id,
    toolName: options.toolCall.function.name,
    turnId: options.turnId,
  };
}

export function createPendingToolMessage(options: {
  parentPartId?: string;
  projectId?: string;
  startedAtMs?: number;
  toolCall: OpenAIChatToolCall;
  turnId: string;
}): Message {
  const timestamp = options.startedAtMs ?? Date.now();

  return {
    content: "",
    createdAtLabel: formatExactMessageTimestamp(timestamp),
    createdAtMs: timestamp,
    id: `message-tool-${options.toolCall.id}`,
    parts: [
      {
        createdAtMs: timestamp,
        id: `message-tool-${options.toolCall.id}-result`,
        metadata: {
          arguments: parseToolArguments(options.toolCall.function.arguments),
          projectId: options.projectId,
          startedAtMs: timestamp,
          status: "running",
          toolName: options.toolCall.function.name,
        },
        name: options.toolCall.function.name,
        parentPartId: options.parentPartId,
        status: "running",
        toolCallId: options.toolCall.id,
        type: "tool_result",
      },
    ],
    role: "tool",
    status: "streaming",
    toolCallId: options.toolCall.id,
    toolName: options.toolCall.function.name,
    turnId: options.turnId,
  };
}

export function createToolCallState(toolCall: OpenAIChatToolCall): ToolCall {
  return {
    id: toolCall.id,
    input: toolCall.function.arguments,
    name: toolCall.function.name,
    status: "pending",
  };
}
