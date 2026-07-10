export type ContextCompactionPhase = "compacting" | "compacted";

export type ContextCompactionStatus = {
  afterMessageCount: number;
  phase: ContextCompactionPhase;
  updatedAtMs: number;
};

export type ContextStatusLabel = "Compacting context…" | "Compacted context";

export function contextStatusLabel(phase: ContextCompactionPhase): ContextStatusLabel {
  return phase === "compacting" ? "Compacting context…" : "Compacted context";
}

export function beginContextCompaction(
  _previous: ContextCompactionStatus | null | undefined,
  messageCount: number,
  nowMs = Date.now(),
): ContextCompactionStatus {
  return {
    afterMessageCount: Math.max(0, messageCount),
    phase: "compacting",
    updatedAtMs: nowMs,
  };
}

export function completeContextCompaction(
  previous: ContextCompactionStatus | null | undefined,
  nowMs = Date.now(),
): ContextCompactionStatus {
  return {
    afterMessageCount: previous?.afterMessageCount ?? 0,
    phase: "compacted",
    updatedAtMs: nowMs,
  };
}

/**
 * Build a linear list of chat items with an inline context divider inserted
 * after `afterMessageCount` messages.
 */
export function interleaveContextStatus<T>(
  messages: T[],
  status: ContextCompactionStatus | null | undefined,
): Array<{ type: "message"; message: T } | { type: "context-status"; phase: ContextCompactionPhase }> {
  if (!status) {
    return messages.map((message) => ({ type: "message" as const, message }));
  }

  const insertAt = Math.min(Math.max(0, status.afterMessageCount), messages.length);
  const items: Array<
    { type: "message"; message: T } | { type: "context-status"; phase: ContextCompactionPhase }
  > = [];

  for (let index = 0; index < messages.length; index += 1) {
    if (index === insertAt) {
      items.push({ type: "context-status", phase: status.phase });
    }
    items.push({ type: "message", message: messages[index]! });
  }

  if (insertAt >= messages.length) {
    items.push({ type: "context-status", phase: status.phase });
  }

  return items;
}
