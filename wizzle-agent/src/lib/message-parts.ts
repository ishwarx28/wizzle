import type { DisplayMessage, Message, MessagePart, ToolCall, ToolResult } from "../types/workspace";

function annotateDisplayPart(message: Message, part: MessagePart): MessagePart {
  if (part.type !== "reasoning") {
    return { ...part };
  }

  return {
    ...part,
    durationMs: part.durationMs ?? message.reasoningDurationMs ?? message.durationMs,
  };
}

function buildReasoningPart(message: Message): MessagePart[] {
  void message;
  return [];
}

function buildLegacyToolParts(message: Message): MessagePart[] {
  const toolResultsByCallId = new Map<string, ToolResult[]>();

  for (const toolResult of message.toolResults ?? []) {
    const key = toolResult.toolCallId ?? toolResult.id;
    const existing = toolResultsByCallId.get(key) ?? [];
    existing.push(toolResult);
    toolResultsByCallId.set(key, existing);
  }

  const parts: MessagePart[] = [];

  for (const toolCall of message.toolCalls ?? []) {
    const toolCallPartId = `${message.id}-tool-call-${toolCall.id}`;
    parts.push({
      createdAtMs: message.startedAtMs ?? message.createdAtMs,
      id: toolCallPartId,
      input: toolCall.input,
      name: toolCall.name,
      // tool_call parents the assistant message; tool_result parents the tool_call.
      parentPartId: message.id,
      status: toolCall.status,
      toolCallId: toolCall.id,
      type: "tool_call",
    });

    for (const toolResult of toolResultsByCallId.get(toolCall.id) ?? []) {
      parts.push({
        createdAtMs: message.startedAtMs ?? message.createdAtMs,
        error: toolResult.error,
        id: toolResult.id,
        output: toolResult.output,
        parentPartId: toolCallPartId,
        status: toolResult.status,
        toolCallId: toolResult.toolCallId ?? toolCall.id,
        type: "tool_result",
      });
    }
  }

  const unmatchedResults = (message.toolResults ?? []).filter(
    (toolResult) => !message.toolCalls?.some((toolCall) => toolCall.id === (toolResult.toolCallId ?? "")),
  );

  for (const toolResult of unmatchedResults) {
    parts.push({
      createdAtMs: message.startedAtMs ?? message.createdAtMs,
      error: toolResult.error,
      id: toolResult.id,
      output: toolResult.output,
      status: toolResult.status,
      toolCallId: toolResult.toolCallId,
      type: "tool_result",
    });
  }

  return parts;
}

function buildContentPart(message: Message): MessagePart[] {
  const content = message.content.trim();

  if (!content) {
    return [];
  }

  return [
    {
      content: message.content,
      createdAtMs: message.completedAtMs ?? message.createdAtMs,
      id: `${message.id}-content`,
      status: message.status,
      type: "content",
    },
  ];
}

function buildActivityContentPart(message: Message): MessagePart[] {
  const content = message.content.trim();

  if (!content) {
    return [];
  }

  return [
    {
      content: message.content,
      createdAtMs: message.startedAtMs ?? message.createdAtMs,
      id: `${message.id}-activity-content`,
      status: message.status,
      type: "activity_content",
    },
  ];
}

function buildAssistantLegacyParts(message: Message) {
  const hasToolCalls = (message.toolCalls?.length ?? 0) > 0;

  return [
    ...buildReasoningPart(message),
    ...(hasToolCalls ? buildActivityContentPart(message) : []),
    ...buildLegacyToolParts(message),
    ...(!hasToolCalls ? buildContentPart(message) : []),
  ];
}

function buildToolMessagePart(message: Message): MessagePart[] {
  const output = message.content.trim() ? message.content : undefined;

  if (!output && !message.toolCallId) {
    return [];
  }

  return [
    {
      createdAtMs: message.completedAtMs ?? message.createdAtMs,
      error: message.status === "error" ? message.content : undefined,
      id: `${message.id}-tool-result`,
      name: message.toolName,
      output,
      status: message.status,
      toolCallId: message.toolCallId,
      type: "tool_result",
    },
  ];
}

export function getMessageParts(message: Message) {
  if (message.parts?.length) {
    return message.parts.filter((part) => part.type !== "reasoning");
  }

  if (message.role === "tool") {
    return buildToolMessagePart(message);
  }

  if (message.role !== "assistant") {
    return buildContentPart(message);
  }

  return buildAssistantLegacyParts(message);
}

/**
 * Final assistant bubble text (`content` parts only).
 * Pre-tool narration lives in `activity_content` and is shown in the activity
 * panel — do not fall back to `message.content` when only activity parts exist,
 * or the UI double-renders after #49 sync.
 */
export function getMessageContent(message: Message) {
  if (message.role === "user") {
    return message.content;
  }

  const parts = getMessageParts(message);

  if (message.role === "assistant" && parts.length > 0) {
    return parts
      .filter((part) => part.type === "content")
      .map((part) => part.content ?? "")
      .join("");
  }

  const contentParts = parts.filter((part) => part.type === "content");

  if (contentParts.length === 0) {
    return message.content;
  }

  return contentParts.map((part) => part.content ?? "").join("");
}

/**
 * Full assistant text for replay, compaction, and durable anchors:
 * activity_content (pre-tool) + content (final), in part order (#49/#50/#51).
 */
export function getAssistantConversationContent(message: Message) {
  if (message.role !== "assistant") {
    return getMessageContent(message);
  }

  const parts = getMessageParts(message);
  const contentParts = parts.filter(
    (part) => part.type === "activity_content" || part.type === "content",
  );

  if (contentParts.length === 0) {
    return message.content;
  }

  return contentParts.map((part) => part.content ?? "").join("");
}

/** Join activity + final content parts in order (shared by sync + tests). */
export function resolveAssistantDurableContentFromParts(parts: MessagePart[]) {
  return parts
    .filter((part) => part.type === "activity_content" || part.type === "content")
    .map((part) => part.content ?? "")
    .join("");
}

export function appendMessagePart(
  parts: MessagePart[] | undefined,
  nextPart: MessagePart,
  match?: (part: MessagePart) => boolean,
) {
  const nextParts = parts ? [...parts] : [];

  if (match) {
    const index = nextParts.findIndex(match);

    if (index >= 0) {
      nextParts[index] = nextPart;
      return nextParts;
    }
  }

  nextParts.push(nextPart);
  return nextParts;
}

export function updateMatchingMessagePart(
  parts: MessagePart[] | undefined,
  match: (part: MessagePart) => boolean,
  updater: (part: MessagePart) => MessagePart,
) {
  const nextParts = parts ? [...parts] : [];
  const index = nextParts.findIndex(match);

  if (index < 0) {
    return nextParts;
  }

  nextParts[index] = updater(nextParts[index]!);
  return nextParts;
}

export function createToolCallFromPart(part: MessagePart): ToolCall | null {
  if (part.type !== "tool_call" || !part.name) {
    return null;
  }

  return {
    id: part.toolCallId ?? part.id,
    input: part.input,
    name: part.name,
    status: part.status,
  };
}

export function createToolResultFromPart(part: MessagePart): ToolResult | null {
  if (part.type !== "tool_result") {
    return null;
  }

  return {
    error: part.error,
    id: part.id,
    output: part.output,
    status: part.status,
    toolCallId: part.toolCallId,
  };
}

export function synchronizeMessageFromParts(message: Message) {
  const parts = getMessageParts(message);

  message.parts = parts;

  if (message.role === "assistant") {
    const toolCalls: ToolCall[] = [];
    const toolResults: ToolResult[] = [];

    for (const part of parts) {
      if (part.type === "activity_content" || part.type === "content") {
        continue;
      }

      if (part.type === "tool_call") {
        const toolCall = createToolCallFromPart(part);

        if (toolCall) {
          toolCalls.push(toolCall);
        }
        continue;
      }

      const toolResult = createToolResultFromPart(part);

      if (toolResult) {
        toolResults.push(toolResult);
      }
    }

    // Durable top-level content includes pre-tool activity (#49 / #50).
    message.content = resolveAssistantDurableContentFromParts(parts);
    message.reasoning = "";
    message.toolCalls = toolCalls;
    message.toolResults = toolResults;
    return message;
  }

  if (message.role === "tool") {
    const toolResultPart = parts.find((part) => part.type === "tool_result");

    if (toolResultPart) {
      message.content = toolResultPart.output ?? toolResultPart.error ?? message.content;
      message.toolCallId = toolResultPart.toolCallId ?? message.toolCallId;
      message.toolName = toolResultPart.name ?? message.toolName;
    }

    return message;
  }

  message.content = getMessageContent(message);
  return message;
}

function canGroupAssistantMessages(current: Message, next: Message) {
  if (current.role === "user" || next.role === "user") {
    return false;
  }

  if (current.turnId && next.turnId) {
    return current.turnId === next.turnId;
  }

  return true;
}

export function buildDisplayMessages(messages: Message[]): DisplayMessage[] {
  const displayMessages: DisplayMessage[] = [];
  let index = 0;

  while (index < messages.length) {
    const currentMessage = messages[index]!;

    if (currentMessage.role === "user") {
      displayMessages.push({
        content: currentMessage.content,
        createdAtLabel: currentMessage.createdAtLabel,
        createdAtMs: currentMessage.createdAtMs,
        editedAtMs: currentMessage.editedAtMs,
        id: currentMessage.id,
        linkedFileIds: currentMessage.linkedFileIds,
        messages: [currentMessage],
        parts: getMessageParts(currentMessage),
        role: "user",
        status: currentMessage.status,
      });
      index += 1;
      continue;
    }

    const groupedMessages: Message[] = [currentMessage];
    index += 1;

    while (index < messages.length && canGroupAssistantMessages(currentMessage, messages[index]!)) {
      groupedMessages.push(messages[index]!);
      index += 1;
    }

    const parts = groupedMessages.flatMap((message) =>
      getMessageParts(message).map((part) => annotateDisplayPart(message, part)),
    );
    const linkedFileIds = Array.from(
      new Set(groupedMessages.flatMap((message) => message.linkedFileIds ?? [])),
    );
    // Final bubble only (content parts). Activity stays in parts/activity panel.
    const content = groupedMessages
      .filter((message) => message.role === "assistant")
      .map((message) => getMessageContent(message))
      .join("");
    const firstStartedAtMs = groupedMessages
      .map((message) => message.startedAtMs ?? message.createdAtMs)
      .find((value) => typeof value === "number");
    const completedAtMs = [...groupedMessages]
      .reverse()
      .map((message) => message.completedAtMs ?? message.createdAtMs)
      .find((value) => typeof value === "number");
    const createdAtMs = [...groupedMessages]
      .reverse()
      .map((message) => message.completedAtMs ?? message.createdAtMs)
      .find((value) => typeof value === "number");
    const status = groupedMessages.some((message) => message.status === "streaming")
      ? "streaming"
      : groupedMessages.some((message) => message.status === "error")
        ? "error"
        : groupedMessages.some((message) => message.status === "interrupted")
          ? "interrupted"
          : "done";
    const streamingMessages = groupedMessages.filter((message) => message.status === "streaming");
    const transientReasoningActive = streamingMessages.some(
      (message) => message.status === "streaming" && message.transientReasoningActive,
    );
    const transientStreamStarted = streamingMessages.some(
      (message) => message.transientStreamStarted,
    );

    displayMessages.push({
      content,
      createdAtLabel: groupedMessages[groupedMessages.length - 1]?.createdAtLabel ?? currentMessage.createdAtLabel,
      createdAtMs,
      durationMs:
        typeof firstStartedAtMs === "number" && typeof completedAtMs === "number"
          ? Math.max(0, completedAtMs - firstStartedAtMs)
          : undefined,
      id: currentMessage.turnId ?? currentMessage.id,
      linkedFileIds,
      messages: groupedMessages,
      parts,
      role: "assistant",
      startedAtMs: firstStartedAtMs,
      status,
      transientReasoningActive,
      transientStreamStarted,
    });
  }

  return displayMessages;
}
