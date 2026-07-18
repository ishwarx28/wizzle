import type {
  ModelId,
  ProviderRetryStatus,
  ReasoningReplayEntry,
  ReasoningSelection,
  ToolCall,
} from "../../types/workspace";
import { mergeReasoningReplayEntry } from "../reasoning-config";
import {
  streamWorkspaceChat,
  type ChatRequestMessage,
  type OpenAIChatToolCall,
  type ProxyToolDefinition,
} from "../chat-stream";

type StreamedAgentTurn = {
  content: string;
  reasoning: string;
  reasoningReplay: ReasoningReplayEntry[];
  toolCalls: OpenAIChatToolCall[];
};

const KNOWN_AGENT_TOOL_NAMES = new Set([
  "shell",
  "clarify",
  "edit",
  "implementation_plan",
  "read",
  "subagent",
  "write",
]);

export type NormalizedStreamedToolCall =
  | {
      kind: "ready";
      toolCall: OpenAIChatToolCall;
    }
  | {
      error: string;
      kind: "invalid";
      toolCall: OpenAIChatToolCall;
    };

export type NormalizeStreamedToolCallsResult = {
  /** True when the stream opened tool-call slots that were not pure noise. */
  hadToolCallIntents: boolean;
  items: NormalizedStreamedToolCall[];
};

function ensureToolCallEntry(toolCalls: OpenAIChatToolCall[], toolCallIndex: number) {
  while (toolCalls.length <= toolCallIndex) {
    toolCalls.push({
      function: {
        arguments: "",
        name: "",
      },
      id: "",
      type: "function",
    });
  }

  return toolCalls[toolCallIndex]!;
}

/**
 * Merge tool-name stream fragments.
 * Supports token deltas ("sh"+"ell"), cumulative resends ("sh"→"she"→"shell"),
 * and full-name repeats ("shell"+"shell") without concatenating duplicates (#22).
 */
export function mergeStreamedToolNameFragment(current: string, delta: string): string {
  if (!delta) {
    return current;
  }
  if (!current) {
    return delta;
  }
  if (delta === current) {
    return current;
  }
  // Cumulative or full re-send that extends/replaces current.
  if (delta.startsWith(current)) {
    return delta;
  }
  // Stale shorter cumulative fragment.
  if (current.startsWith(delta)) {
    return current;
  }
  // True token delta (e.g. "ba" + "sh").
  return `${current}${delta}`;
}

/**
 * Empty args → "{}". Non-empty must be a JSON object (or array); otherwise invalid (#21).
 */
export function normalizeStreamedToolArguments(rawArguments: string): {
  arguments: string;
  error?: string;
} {
  const trimmed = rawArguments.trim();
  if (!trimmed) {
    return { arguments: "{}" };
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed === null || typeof parsed !== "object") {
      return {
        arguments: trimmed,
        error: "Tool arguments must be a JSON object.",
      };
    }
    // Re-serialize for stable shape; keep original if stringify fails.
    try {
      return { arguments: JSON.stringify(parsed) };
    } catch {
      return { arguments: trimmed };
    }
  } catch {
    return {
      arguments: trimmed,
      error: "Tool arguments were incomplete or not valid JSON.",
    };
  }
}

function isNoiseToolCallSlot(toolCall: OpenAIChatToolCall) {
  return (
    !toolCall.id.trim() &&
    !toolCall.function.name.trim() &&
    !toolCall.function.arguments.trim()
  );
}

export function buildStreamingToolCallPreviews(
  toolCalls: OpenAIChatToolCall[],
): OpenAIChatToolCall[] {
  return toolCalls
    .map((toolCall) => {
      const id = toolCall.id.trim();
      const name = toolCall.function.name.trim();

      if (!id || !name) {
        return null;
      }

      return {
        function: {
          arguments: "",
          name,
        },
        id,
        type: "function" as const,
      };
    })
    .filter((toolCall): toolCall is OpenAIChatToolCall => Boolean(toolCall));
}

/**
 * Normalize streamed tool calls for execution.
 * Invalid names/args become `invalid` items (do not execute) instead of being
 * dropped or coerced to empty `{}` silently (#21 / #38).
 */
export function normalizeStreamedToolCalls(
  toolCalls: OpenAIChatToolCall[],
  step: number,
): NormalizeStreamedToolCallsResult {
  const items: NormalizedStreamedToolCall[] = [];
  let hadToolCallIntents = false;

  toolCalls.forEach((toolCall, index) => {
    if (isNoiseToolCallSlot(toolCall)) {
      return;
    }

    hadToolCallIntents = true;
    const id = toolCall.id.trim() || `tool-call-${step + 1}-${index + 1}`;
    const name = toolCall.function.name.trim();
    const argResult = normalizeStreamedToolArguments(toolCall.function.arguments);
    const normalizedCall: OpenAIChatToolCall = {
      function: {
        arguments: argResult.arguments,
        name,
      },
      id,
      type: "function",
    };

    if (!name) {
      items.push({
        error: "Tool call was missing a tool name.",
        kind: "invalid",
        toolCall: {
          ...normalizedCall,
          function: {
            ...normalizedCall.function,
            name: "unknown",
          },
        },
      });
      return;
    }

    if (!KNOWN_AGENT_TOOL_NAMES.has(name)) {
      items.push({
        error: `Unknown tool name "${name}". Expected one of: shell, clarify, edit, implementation_plan, read, subagent, write.`,
        kind: "invalid",
        toolCall: normalizedCall,
      });
      return;
    }

    if (argResult.error) {
      items.push({
        error: argResult.error,
        kind: "invalid",
        toolCall: normalizedCall,
      });
      return;
    }

    items.push({
      kind: "ready",
      toolCall: normalizedCall,
    });
  });

  return {
    hadToolCallIntents,
    items,
  };
}

export function countReadyToolCalls(result: NormalizeStreamedToolCallsResult) {
  return result.items.filter((item) => item.kind === "ready").length;
}

export function resolveAgentTurnToolChoice(
  tools: readonly ProxyToolDefinition[],
  override?: "auto" | "none",
) {
  return override ?? (tools.length > 0 ? "auto" : "none");
}

export async function streamAgentTurn(options: {
  chatId: string;
  conversation: ChatRequestMessage[];
  maxTokens?: number;
  modelId: ModelId;
  onChunk: (chunk: { kind: "content" | "reasoning"; text: string }) => void;
  onReasoningFinished?: () => void;
  onProviderRetry?: (status: ProviderRetryStatus | null) => void;
  onToolCalls?: (toolCalls: ToolCall[]) => void;
  projectId: string;
  reasoningLevel?: string | null;
  reasoningSelection?: ReasoningSelection;
  streamKey?: string;
  toolChoice?: "auto" | "none";
  tools: ProxyToolDefinition[];
  turnIndex: number;
  toToolCallState: (toolCall: OpenAIChatToolCall) => ToolCall;
}) {
  const streamedTurn: StreamedAgentTurn = {
    content: "",
    reasoning: "",
    reasoningReplay: [],
    toolCalls: [],
  };
  let lastToolCallPreviewSignature = "";

  await streamWorkspaceChat({
    chatId: options.chatId,
    history: options.conversation,
    maxTokens: options.maxTokens,
    modelId: options.modelId,
    onChunk: (chunk) => {
      if (chunk.kind === "content" || chunk.kind === "reasoning") {
        if (chunk.kind === "content") {
          streamedTurn.content += chunk.text;
        } else {
          streamedTurn.reasoning += chunk.text;
        }

        options.onChunk(chunk);
        return;
      }

      if (chunk.kind === "reasoningReplay") {
        streamedTurn.reasoningReplay = mergeReasoningReplayEntry(
          streamedTurn.reasoningReplay,
          chunk.entry,
        );
        return;
      }

      const toolCallIndex = (chunk as Extract<typeof chunk, { toolCallIndex: number }>).toolCallIndex;
      const toolCall = ensureToolCallEntry(streamedTurn.toolCalls, toolCallIndex);

      if (chunk.kind === "toolCallId") {
        toolCall.id = chunk.text;
      } else if (chunk.kind === "toolName") {
        toolCall.function.name = mergeStreamedToolNameFragment(
          toolCall.function.name,
          chunk.text,
        );
      } else {
        toolCall.function.arguments += chunk.text;
      }

      if (!options.onToolCalls || chunk.kind === "toolArguments") {
        return;
      }

      const previewCalls = buildStreamingToolCallPreviews(streamedTurn.toolCalls).map(
        options.toToolCallState,
      );
      const previewSignature = previewCalls
        .map((call) => `${call.id}\u0000${call.name}`)
        .join("\u0001");

      if (previewCalls.length > 0 && previewSignature !== lastToolCallPreviewSignature) {
        lastToolCallPreviewSignature = previewSignature;
        options.onToolCalls(previewCalls);
      }
    },
    onReasoningFinished: options.onReasoningFinished,
    onRetry: options.onProviderRetry,
    projectId: options.projectId,
    reasoningLevel: options.reasoningLevel ?? undefined,
    reasoningSelection: options.reasoningSelection,
    streamKey: options.streamKey,
    toolChoice: resolveAgentTurnToolChoice(options.tools, options.toolChoice),
    tools: options.tools,
  });

  return streamedTurn;
}
