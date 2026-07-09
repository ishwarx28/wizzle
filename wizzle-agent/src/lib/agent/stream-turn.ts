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

export function normalizeStreamedToolCalls(toolCalls: OpenAIChatToolCall[], step: number) {
  return toolCalls
    .map((toolCall, index) => ({
      function: {
        arguments: toolCall.function.arguments.trim() || "{}",
        name: toolCall.function.name.trim(),
      },
      id: toolCall.id.trim() || `tool-call-${step + 1}-${index + 1}`,
      type: "function" as const,
    }))
    .filter((toolCall) => toolCall.function.name && toolCall.id.trim());
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
        toolCall.function.name += chunk.text;
      } else {
        toolCall.function.arguments += chunk.text;
      }

    },
    onReasoningFinished: options.onReasoningFinished,
    projectId: options.projectId,
    reasoningLevel: options.reasoningLevel ?? undefined,
    toolChoice: options.tools.length > 0 ? "auto" : "none",
    tools: options.tools,
  });

  return streamedTurn;
}
