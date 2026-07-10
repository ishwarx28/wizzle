import type { ModelId, ToolCall } from "../../types/workspace";
import {
  streamWorkspaceChat,
  type ChatRequestMessage,
  type OpenAIChatToolCall,
  type ProxyToolDefinition,
} from "../chat-stream";

type StreamedAgentTurn = {
  content: string;
  reasoning: string;
  toolCalls: OpenAIChatToolCall[];
};

const KNOWN_AGENT_TOOL_NAMES = new Set(["bash", "edit", "read", "write"]);

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
 * Supports token deltas ("ba"+"sh"), cumulative resends ("ba"→"bas"→"bash"),
 * and full-name repeats ("bash"+"bash") without concatenating duplicates (#22).
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
        error: `Unknown tool name "${name}". Expected one of: bash, edit, read, write.`,
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
  modelId: ModelId;
  onChunk: (chunk: { kind: "content" | "reasoning"; text: string }) => void;
  onReasoningFinished?: () => void;
  onToolCalls?: (toolCalls: ToolCall[]) => void;
  projectId: string;
  reasoningLevel?: string | null;
  toolChoice?: "auto" | "none";
  tools: ProxyToolDefinition[];
  turnIndex: number;
  toToolCallState: (toolCall: OpenAIChatToolCall) => ToolCall;
}) {
  const streamedTurn: StreamedAgentTurn = {
    content: "",
    reasoning: "",
    toolCalls: [],
  };

  await streamWorkspaceChat({
    chatId: options.chatId,
    history: options.conversation,
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

      // Progressive tool-call UI when the host wires onToolCalls (#14 still partial).
      if (options.onToolCalls) {
        const preview = normalizeStreamedToolCalls(streamedTurn.toolCalls, options.turnIndex);
        const previewCalls = preview.items.map((item) =>
          options.toToolCallState(item.toolCall),
        );
        if (previewCalls.length > 0) {
          options.onToolCalls(previewCalls);
        }
      }
    },
    onReasoningFinished: options.onReasoningFinished,
    projectId: options.projectId,
    reasoningLevel: options.reasoningLevel ?? undefined,
    toolChoice: resolveAgentTurnToolChoice(options.tools, options.toolChoice),
    tools: options.tools,
  });

  return streamedTurn;
}
