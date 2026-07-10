import type { Message, MessagePart } from "../types/workspace";

export type SettleTurnStatus = "done" | "error" | "interrupted";

function isTerminalMessageStatus(status: Message["status"] | MessagePart["status"] | undefined) {
  return status === "done" || status === "error" || status === "interrupted";
}

/**
 * User prompts are successful input. Never mark them error/interrupted, and never
 * assign assistantPhase (#9, #64).
 */
export function settleUserMessageFields(message: Message): void {
  if (message.role !== "user") {
    return;
  }

  message.status = "done";
  delete message.assistantPhase;
}

/**
 * Apply settle status to an assistant message.
 * Completed assistants keep their terminal status when the outer turn fails or is
 * interrupted (#10). Only incomplete/streaming assistants inherit the turn status.
 */
export function settleAssistantMessageFields(
  message: Message,
  turnStatus: SettleTurnStatus,
  completedAtMs: number,
): void {
  if (message.role !== "assistant") {
    return;
  }

  message.completedAtMs = message.completedAtMs ?? completedAtMs;
  message.durationMs = message.startedAtMs
    ? Math.max(0, message.completedAtMs - message.startedAtMs)
    : message.durationMs;
  message.reasoningDurationMs =
    message.reasoningDurationMs ??
    (message.startedAtMs
      ? Math.max(0, message.completedAtMs - message.startedAtMs)
      : message.reasoningDurationMs);

  if (!message.assistantPhase) {
    message.assistantPhase =
      (message.toolCalls?.length ?? 0) > 0 ? "working" : "final";
  }

  const alreadyTerminal = isTerminalMessageStatus(message.status);

  if (alreadyTerminal && turnStatus !== "done") {
    // Keep prior success/failure; only finish incomplete work below.
    message.parts = (message.parts ?? []).map((part) => {
      if (isTerminalMessageStatus(part.status)) {
        return part;
      }

      return {
        ...part,
        status:
          turnStatus === "error"
            ? "error"
            : turnStatus === "interrupted"
              ? "interrupted"
              : "done",
      };
    });
    return;
  }

  message.status = turnStatus === "done" ? "done" : turnStatus;
  message.parts = (message.parts ?? []).map((part) => {
    if (part.status === "error") {
      return part;
    }

    if (isTerminalMessageStatus(part.status) && turnStatus !== "done") {
      return part;
    }

    return {
      ...part,
      status:
        turnStatus === "error"
          ? "error"
          : turnStatus === "interrupted"
            ? "interrupted"
            : "done",
    };
  });
}

/**
 * Apply settle rules to a non-tool message in a turn (user or assistant).
 */
export function settleNonToolTurnMessage(
  message: Message,
  turnStatus: SettleTurnStatus,
  completedAtMs: number,
): void {
  if (message.role === "user") {
    settleUserMessageFields(message);
    message.completedAtMs = message.completedAtMs ?? completedAtMs;
    return;
  }

  if (message.role === "assistant") {
    settleAssistantMessageFields(message, turnStatus, completedAtMs);
  }
}
