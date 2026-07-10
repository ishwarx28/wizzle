import type { ContextCompactionPhase, SessionEvent } from "../types/workspace";

export type { ContextCompactionPhase };

export type ContextCompactionStatus = {
  afterMessageCount: number;
  eventId?: string;
  phase: ContextCompactionPhase;
  updatedAtMs: number;
};

export type ContextStatusLabel = "Compacting context" | "Compacted context";

export function contextStatusLabel(phase: ContextCompactionPhase): ContextStatusLabel {
  return phase === "compacting" ? "Compacting context" : "Compacted context";
}

export function createContextCompactionEvent(
  phase: ContextCompactionPhase,
  messageCount: number,
  nowMs = Date.now(),
): SessionEvent {
  return {
    id: `context-event-${crypto.randomUUID()}`,
    afterMessageCount: Math.max(0, messageCount),
    createdAtMs: nowMs,
    phase,
    type: "context_status",
    updatedAtMs: nowMs,
  };
}

export function beginContextCompaction(
  _previous: ContextCompactionStatus | null | undefined,
  messageCount: number,
  nowMs = Date.now(),
  eventId?: string,
): ContextCompactionStatus {
  return {
    afterMessageCount: Math.max(0, messageCount),
    eventId,
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
    eventId: previous?.eventId,
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
  events: Array<Pick<SessionEvent, "afterMessageCount" | "id" | "phase">> | null | undefined,
): Array<{ type: "message"; message: T } | { type: "context-status"; eventId: string; phase: ContextCompactionPhase }> {
  if (!events?.length) {
    return messages.map((message) => ({ type: "message" as const, message }));
  }

  const eventsByInsertAt = new Map<
    number,
    Array<Pick<SessionEvent, "afterMessageCount" | "id" | "phase">>
  >();
  for (const event of events) {
    const insertAt = Math.min(Math.max(0, event.afterMessageCount), messages.length);
    const existing = eventsByInsertAt.get(insertAt) ?? [];
    existing.push(event);
    eventsByInsertAt.set(insertAt, existing);
  }

  const items: Array<
    { type: "message"; message: T } | { type: "context-status"; eventId: string; phase: ContextCompactionPhase }
  > = [];

  for (let index = 0; index < messages.length; index += 1) {
    const pendingEvents = eventsByInsertAt.get(index) ?? [];
    for (const event of pendingEvents) {
      items.push({ type: "context-status", eventId: event.id, phase: event.phase });
    }
    items.push({ type: "message", message: messages[index]! });
  }

  const pendingEvents = eventsByInsertAt.get(messages.length) ?? [];
  for (const event of pendingEvents) {
    items.push({ type: "context-status", eventId: event.id, phase: event.phase });
  }

  return items;
}
