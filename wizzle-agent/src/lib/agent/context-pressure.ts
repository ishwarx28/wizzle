/**
 * Context-pressure path when the active turn will not fit after older-turn
 * compaction. See planning/compacting-current-turn.md.
 */

import type { Message } from "../../types/workspace";
import { getRemotePrompt } from "../remote-config";

/** Short identity system prompt for the pressure forced-final call only. */
export function resolveContextPressureSystemPrompt() {
  return getRemotePrompt("context-pressure");
}

/** Auto-continue user prompt after pressure settle + compaction opportunity. */
export const CONTEXT_CONTINUE_PROMPT =
  "Continue previous task after context compaction. Resume from the latest progress; do not redo completed work.";

export const MAX_REINFLATED_COMPACTED_TURNS = 5;

export type WorkspaceAgentFinishReason =
  | "done"
  | "context_pressure"
  | "max_steps"
  | "error"
  | "interrupted";

export type WorkspaceAgentRunResult = {
  finishReason: WorkspaceAgentFinishReason;
};

export function shouldAutoContinueAfterExceptionalFinish(
  finishReason: WorkspaceAgentFinishReason,
) {
  return finishReason === "context_pressure" || finishReason === "max_steps";
}

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

export async function persistPendingImplementationPlanForContextContinuation(options: {
  hasPendingPlan: boolean;
  persistPlan: () => Promise<unknown>;
}) {
  if (!options.hasPendingPlan) {
    return false;
  }

  return (await options.persistPlan()) !== false;
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

  if (withFinalPhase) {
    return hasUsableAssistantText(withFinalPhase) ? stripToolActivity(withFinalPhase) : null;
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
  const content = message.content?.trim() ?? "";

  return Boolean(
    content &&
      !containsRawToolSyntax(content) &&
      !content.startsWith("Context filled up during this turn."),
  );
}

function stripToolActivity(message: Message): Message {
  return {
    ...message,
    assistantPhase: message.assistantPhase ?? "final",
    toolCalls: undefined,
    toolResults: undefined,
  };
}

/** Provider-native tool markup must never be accepted as a user-facing final. */
export function containsRawToolSyntax(content: string) {
  const normalized = content.trim();

  return (
    /<[^>]*DSML[^>]*tool_calls[^>]*>/iu.test(normalized) ||
    /<tool_calls?>/iu.test(normalized) ||
    (/<invoke\s+name=/iu.test(normalized) && /<parameter\s+name=/iu.test(normalized))
  );
}
