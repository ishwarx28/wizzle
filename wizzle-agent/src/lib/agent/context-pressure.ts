/**
 * Context-pressure path when the active turn will not fit after older-turn
 * compaction. See planning/compacting-current-turn.md.
 */

import type { Message } from "../../types/workspace";

/** Short identity system prompt for the pressure forced-final call only. */
export const CONTEXT_PRESSURE_SYSTEM_PROMPT = [
  "You are Wizzle, a desktop coding agent.",
  "Help the user based on the conversation so far.",
  "Be concise and direct.",
  "Do not call tools.",
  "Do not restate the entire history.",
].join("\n");

/** Nudge appended for the pressure forced-final model call. */
export const CONTEXT_PRESSURE_FINAL_NUDGE =
  "Give a brief response based on current findings of last user request / task";

/** Auto-continue user prompt after pressure settle + compaction opportunity. */
export const CONTEXT_CONTINUE_PROMPT =
  "Continue previous task after context compaction. Resume from the latest progress; do not redo completed work.";

export const MAX_REINFLATED_COMPACTED_TURNS = 5;

export type WorkspaceAgentFinishReason =
  | "done"
  | "context_pressure"
  | "error"
  | "interrupted";

export type WorkspaceAgentRunResult = {
  finishReason: WorkspaceAgentFinishReason;
};

/** Only enter pressure after tools have grown the active turn. */
export function shouldEnterContextPressure(options: {
  code?: string;
  usedToolsInTurn: boolean;
}): boolean {
  if (!options.usedToolsInTurn) {
    return false;
  }

  // Fixed cost / model-too-small are not recoverable via pressure final.
  if (
    options.code === "system_tool_prompt_too_large" ||
    options.code === "selected_model_context_too_small"
  ) {
    return false;
  }

  return (
    options.code === "current_message_too_large" ||
    options.code === "attachments_too_large" ||
    options.code === undefined
  );
}

/**
 * Final assistant for reinflate: prefer assistantPhase final, else last
 * assistant with non-empty content. No tool activity.
 */
export function pickFinalAssistantMessage(messages: readonly Message[]): Message | null {
  const assistants = messages.filter((message) => message.role === "assistant");

  if (assistants.length === 0) {
    return null;
  }

  const withFinalPhase = [...assistants]
    .reverse()
    .find((message) => message.assistantPhase === "final");

  if (withFinalPhase && hasUsableAssistantText(withFinalPhase)) {
    return stripToolActivity(withFinalPhase);
  }

  const withContent = [...assistants]
    .reverse()
    .find((message) => hasUsableAssistantText(message));

  return withContent ? stripToolActivity(withContent) : null;
}

export function extractUserAndFinalMessages(messages: readonly Message[]): Message[] {
  const user = messages.find((message) => message.role === "user");
  const finalAssistant = pickFinalAssistantMessage(messages);

  if (!user || !finalAssistant) {
    return [];
  }

  return [user, finalAssistant];
}

function hasUsableAssistantText(message: Message) {
  return Boolean(message.content?.trim());
}

function stripToolActivity(message: Message): Message {
  return {
    ...message,
    assistantPhase: message.assistantPhase ?? "final",
    toolCalls: undefined,
    toolResults: undefined,
  };
}

/**
 * History for pressure final when full active turn (with tools) is too large:
 * drop tool-role messages so the model still sees user + assistant text.
 */
export function stripToolRoleMessages(history: readonly Message[]): Message[] {
  return history.filter((message) => message.role !== "tool");
}
