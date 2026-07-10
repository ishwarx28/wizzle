import type { Message } from "../types/workspace";

/**
 * Turn ids still present after an in-memory edit truncate (#3 / #57).
 * Includes `summary-*` only if they remain in messages (usually they do not).
 */
export function collectRetainedTurnIds(messages: Message[]): string[] {
  const ids = new Set<string>();

  for (const message of messages) {
    const turnId = message.turnId?.trim();
    if (turnId) {
      ids.add(turnId);
    }
  }

  return Array.from(ids);
}

/**
 * Compacted-turn bookkeeping: drop ids that are no longer in the retained set
 * so session summary flags do not reference deleted turns (#72-adjacent).
 */
export function filterCompactedTurnIds(
  compactedTurnIds: string[] | null | undefined,
  retainedTurnIds: ReadonlySet<string> | string[],
): string[] {
  const retained = retainedTurnIds instanceof Set ? retainedTurnIds : new Set(retainedTurnIds);
  return (compactedTurnIds ?? []).filter((turnId) => retained.has(turnId));
}
